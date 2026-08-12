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
from relay_backend.data.idempotency_repository import IdempotencyRepository
from relay_backend.data.namespace_repository import NamespaceRepository
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
        namespace_repository: NamespaceRepository | None = None,
        idempotency_repository: IdempotencyRepository | None = None,
        clock: Callable[[], datetime] | None = None,
        uuid_factory: Callable[[], UUID] | None = None,
    ) -> None:
        self.database = database
        self.document_store = document_store
        self.repository = repository or WorkflowRepository()
        self.namespace_repository = namespace_repository or NamespaceRepository()
        self.idempotency_repository = idempotency_repository or IdempotencyRepository()
        self.clock = clock or (lambda: datetime.now(UTC))
        self.uuid_factory = uuid_factory or uuid4

    def list(self) -> WorkflowListResponse:
        with self._transaction() as connection:
            return WorkflowListResponse(workflows=self.repository.list_summaries(connection))

    def list_scoped(self, namespace_id: UUID) -> WorkflowListResponse:
        with self._transaction() as connection:
            self.namespace_repository.require_scope(connection, namespace_id)
            return WorkflowListResponse(
                workflows=self.repository.list_scoped_summaries(connection, namespace_id)
            )

    def create(self, idempotency_key: UUID) -> Workflow:
        with self._transaction() as connection:
            namespace_id = self.namespace_repository.get_or_create_default(
                connection, self.uuid_factory()
            )
            return self._create(connection, namespace_id, "/v1/workflows", idempotency_key)

    def create_scoped(self, namespace_id: UUID, idempotency_key: UUID) -> Workflow:
        with self._transaction() as connection:
            self.namespace_repository.require_scope(connection, namespace_id)
            return self._create(
                connection,
                namespace_id,
                f"/v1/namespaces/{namespace_id}/workflows",
                idempotency_key,
            )

    def _create(
        self,
        connection: Connection,
        namespace_id: UUID,
        path: str,
        idempotency_key: UUID,
    ) -> Workflow:
        method = "POST"
        replay = self.idempotency_repository.claim(
            connection,
            key=idempotency_key,
            method=method,
            path=path,
            request_hash=canonical_request_hash(method, path),
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
            namespace_id=namespace_id,
        )
        self.idempotency_repository.complete(
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

    def get_scoped(self, namespace_id: UUID, workflow_id: UUID) -> Workflow:
        with self._transaction() as connection:
            location = self.repository.get_scoped(connection, namespace_id, workflow_id)
        return self._load_document(location)

    def save(
        self,
        workflow_id: UUID,
        request: SaveWorkflowRequest,
        idempotency_key: UUID,
    ) -> Workflow:
        with self._transaction() as connection:
            return self._save(
                connection,
                None,
                workflow_id,
                request,
                idempotency_key,
                path=f"/v1/workflows/{workflow_id}",
            )

    def save_scoped(
        self,
        namespace_id: UUID,
        workflow_id: UUID,
        request: SaveWorkflowRequest,
        idempotency_key: UUID,
    ) -> Workflow:
        with self._transaction() as connection:
            return self._save(
                connection,
                namespace_id,
                workflow_id,
                request,
                idempotency_key,
                path=f"/v1/namespaces/{namespace_id}/workflows/{workflow_id}",
            )

    def _save(
        self,
        connection: Connection,
        namespace_id: UUID | None,
        workflow_id: UUID,
        request: SaveWorkflowRequest,
        idempotency_key: UUID,
        *,
        path: str,
    ) -> Workflow:
        request = _revalidate_request(request)
        _require_matching_id(workflow_id, request.workflow)
        method = "PUT"
        replay = self.idempotency_repository.claim(
            connection,
            key=idempotency_key,
            method=method,
            path=path,
            request_hash=canonical_request_hash(method, path, request),
        )
        if replay is not None:
            return Workflow.model_validate(replay.body)
        location = (
            self.repository.lock(connection, workflow_id)
            if namespace_id is None
            else self.repository.lock_scoped(connection, namespace_id, workflow_id)
        )
        current = self._load_document(location)
        if current.revision != request.expected_revision:
            raise RevisionConflictError
        saved = self._next_snapshot(current, request.workflow)
        document_key = self.document_store.put(saved)
        if namespace_id is None:
            self.repository.update(
                connection,
                saved,
                to_workflow_summary(saved),
                document_key,
                expected_revision=current.revision,
            )
        else:
            self.repository.update_scoped(
                connection,
                saved,
                to_workflow_summary(saved),
                document_key,
                namespace_id=namespace_id,
                expected_revision=current.revision,
            )
        self.idempotency_repository.complete(
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
        with self._transaction() as connection:
            return self._finish(
                connection,
                None,
                workflow_id,
                request,
                idempotency_key,
                path=f"/v1/workflows/{workflow_id}/finish",
            )

    def finish_scoped(
        self,
        namespace_id: UUID,
        workflow_id: UUID,
        request: SaveWorkflowRequest,
        idempotency_key: UUID,
    ) -> Workflow:
        with self._transaction() as connection:
            return self._finish(
                connection,
                namespace_id,
                workflow_id,
                request,
                idempotency_key,
                path=f"/v1/namespaces/{namespace_id}/workflows/{workflow_id}/finish",
            )

    def _finish(
        self,
        connection: Connection,
        namespace_id: UUID | None,
        workflow_id: UUID,
        request: SaveWorkflowRequest,
        idempotency_key: UUID,
        *,
        path: str,
    ) -> Workflow:
        request = _revalidate_request(request)
        _require_matching_id(workflow_id, request.workflow)
        if not request.workflow.steps:
            raise ValidationFailedError("Add at least one workflow step before finishing.")
        method = "POST"
        replay = self.idempotency_repository.claim(
            connection,
            key=idempotency_key,
            method=method,
            path=path,
            request_hash=canonical_request_hash(method, path, request),
        )
        if replay is not None:
            return Workflow.model_validate(replay.body)
        location = (
            self.repository.lock(connection, workflow_id)
            if namespace_id is None
            else self.repository.lock_scoped(connection, namespace_id, workflow_id)
        )
        current = self._load_document(location)
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
        if namespace_id is None:
            self.repository.update(
                connection,
                finished,
                to_workflow_summary(finished),
                document_key,
                expected_revision=current.revision,
            )
        else:
            self.repository.update_scoped(
                connection,
                finished,
                to_workflow_summary(finished),
                document_key,
                namespace_id=namespace_id,
                expected_revision=current.revision,
            )
        self.idempotency_repository.complete(
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
