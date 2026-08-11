from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg import Connection
from psycopg_pool import PoolTimeout
from pydantic import ValidationError

from relay_backend.data.database import Database
from relay_backend.data.workflow_repository import (
    WorkflowDocumentLocation,
    WorkflowRepository,
)
from relay_backend.document_store import WorkflowDocumentStore
from relay_backend.errors import (
    InternalPersistenceError,
    PersistenceUnavailableError,
    RevisionConflictError,
    ValidationFailedError,
    WorkflowError,
)
from relay_backend.models.workflows import (
    SaveWorkflowRequest,
    Workflow,
    WorkflowListResponse,
    WorkflowSource,
    WorkflowStatus,
    canonical_request_hash,
    to_workflow_summary,
)


class WorkflowService:
    def __init__(
        self,
        database: Database,
        document_store: WorkflowDocumentStore,
        *,
        repository: WorkflowRepository | None = None,
        clock: Callable[[], datetime] | None = None,
        uuid_factory: Callable[[], UUID] | None = None,
    ) -> None:
        self.database = database
        self.document_store = document_store
        self.repository = repository or WorkflowRepository()
        self.clock = clock or (lambda: datetime.now(UTC))
        self.uuid_factory = uuid_factory or uuid4

    def list(self) -> WorkflowListResponse:
        with self._transaction() as connection:
            return WorkflowListResponse(workflows=self.repository.list_summaries(connection))

    def create(self, idempotency_key: UUID) -> Workflow:
        method = "POST"
        path = "/v1/workflows"
        request_hash = canonical_request_hash(method, path)
        with self._transaction() as connection:
            replay = self.repository.claim_idempotency(
                connection,
                key=idempotency_key,
                method=method,
                path=path,
                request_hash=request_hash,
            )
            if replay is not None:
                return Workflow.model_validate(replay.body)

            now = self.clock()
            workflow = Workflow(
                schema_version="1.2",
                id=self.uuid_factory(),
                name="Untitled recording",
                status=WorkflowStatus.DRAFT,
                revision=1,
                created_at=now,
                updated_at=now,
                source=WorkflowSource(provider="browserbase", session_id=""),
                steps=[],
            )
            document_key = self.document_store.put(workflow)
            self.repository.insert(
                connection,
                workflow,
                to_workflow_summary(workflow),
                document_key,
            )
            self.repository.complete_idempotency(
                connection,
                key=idempotency_key,
                status=201,
                body=_workflow_json(workflow),
            )
            return workflow

    def get(self, workflow_id: UUID) -> Workflow:
        with self._transaction() as connection:
            location = self.repository.get(connection, workflow_id)
        return self._load_document(location)

    def save(
        self,
        workflow_id: UUID,
        request: SaveWorkflowRequest,
        idempotency_key: UUID,
    ) -> Workflow:
        request = _revalidate_request(request)
        _require_matching_id(workflow_id, request.workflow)
        method = "PUT"
        path = f"/v1/workflows/{workflow_id}"
        with self._transaction() as connection:
            replay = self.repository.claim_idempotency(
                connection,
                key=idempotency_key,
                method=method,
                path=path,
                request_hash=canonical_request_hash(method, path, request),
            )
            if replay is not None:
                return Workflow.model_validate(replay.body)

            current = self._load_document(self.repository.lock(connection, workflow_id))
            if current.revision != request.expected_revision:
                raise RevisionConflictError
            saved = self._next_snapshot(current, request.workflow)
            document_key = self.document_store.put(saved)
            self.repository.update(
                connection,
                saved,
                to_workflow_summary(saved),
                document_key,
                expected_revision=current.revision,
            )
            self.repository.complete_idempotency(
                connection,
                key=idempotency_key,
                status=200,
                body=_workflow_json(saved),
            )
            return saved

    def finish(
        self,
        workflow_id: UUID,
        request: SaveWorkflowRequest,
        idempotency_key: UUID,
    ) -> Workflow:
        request = _revalidate_request(request)
        _require_matching_id(workflow_id, request.workflow)
        if not request.workflow.steps:
            raise ValidationFailedError("Add at least one workflow step before finishing.")
        method = "POST"
        path = f"/v1/workflows/{workflow_id}/finish"
        with self._transaction() as connection:
            replay = self.repository.claim_idempotency(
                connection,
                key=idempotency_key,
                method=method,
                path=path,
                request_hash=canonical_request_hash(method, path, request),
            )
            if replay is not None:
                return Workflow.model_validate(replay.body)

            current = self._load_document(self.repository.lock(connection, workflow_id))
            if current.revision != request.expected_revision:
                raise RevisionConflictError
            now = self.clock()
            finished = self._next_snapshot(
                current,
                request.workflow,
                status=WorkflowStatus.COMPLETE,
                finished_at=current.finished_at or now,
                updated_at=now,
            )
            document_key = self.document_store.put(finished)
            self.repository.update(
                connection,
                finished,
                to_workflow_summary(finished),
                document_key,
                expected_revision=current.revision,
            )
            self.repository.complete_idempotency(
                connection,
                key=idempotency_key,
                status=200,
                body=_workflow_json(finished),
            )
            return finished

    def _load_document(self, location: WorkflowDocumentLocation) -> Workflow:
        if location.object_key is not None:
            workflow = self.document_store.get(location.object_key)
        elif location.legacy_document is not None:
            workflow = location.legacy_document
        else:
            raise InternalPersistenceError
        if workflow.id != location.workflow_id or workflow.revision != location.revision:
            raise InternalPersistenceError
        return workflow

    def _next_snapshot(
        self,
        current: Workflow,
        incoming: Workflow,
        *,
        status: WorkflowStatus | None = None,
        finished_at: datetime | None = None,
        updated_at: datetime | None = None,
    ) -> Workflow:
        document = incoming.model_dump(mode="python")
        document.update(
            {
                "schema_version": "1.2",
                "id": current.id,
                "status": status or current.status,
                "revision": current.revision + 1,
                "created_at": current.created_at,
                "updated_at": updated_at or self.clock(),
                "finished_at": finished_at or current.finished_at,
            }
        )
        return Workflow.model_validate(document)

    @contextmanager
    def _transaction(self) -> Iterator[Connection]:
        try:
            with self.database.transaction() as connection:
                yield connection
        except WorkflowError:
            raise
        except (psycopg.OperationalError, PoolTimeout) as error:
            raise PersistenceUnavailableError from error
        except psycopg.Error as error:
            raise InternalPersistenceError from error


def _revalidate_request(request: SaveWorkflowRequest) -> SaveWorkflowRequest:
    try:
        return SaveWorkflowRequest.model_validate(request.model_dump(mode="python"))
    except ValidationError as error:
        raise ValidationFailedError from error


def _require_matching_id(workflow_id: UUID, workflow: Workflow) -> None:
    if workflow.id != workflow_id:
        raise ValidationFailedError("The workflow ID cannot be changed.")


def _workflow_json(workflow: Workflow) -> dict[str, Any]:
    return workflow.model_dump(mode="json", by_alias=True, exclude_none=True)
