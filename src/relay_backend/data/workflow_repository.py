from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from relay_backend.errors import (
    InternalPersistenceError,
    RevisionConflictError,
    ScopedWorkflowNotFoundError,
    WorkflowNotFoundError,
)
from relay_backend.models.workflows import Workflow, WorkflowSummary


@dataclass(frozen=True)
class WorkflowDocumentLocation:
    workflow_id: UUID
    revision: int
    object_key: str | None
    legacy_document: Workflow | None


@dataclass(frozen=True)
class LegacyWorkflowDocument:
    workflow: Workflow
    revision: int


class WorkflowRepository:
    def list_summaries(self, connection: Connection) -> list[WorkflowSummary]:
        rows = connection.execute(
            "SELECT summary FROM workflows ORDER BY updated_at DESC"
        ).fetchall()
        return [WorkflowSummary.model_validate(row["summary"]) for row in rows]

    def list_scoped_summaries(
        self, connection: Connection, namespace_id: UUID
    ) -> list[WorkflowSummary]:
        rows = connection.execute(
            """
            SELECT summary FROM workflows
             WHERE namespace_id = %s
             ORDER BY updated_at DESC
            """,
            (namespace_id,),
        ).fetchall()
        return [WorkflowSummary.model_validate(row["summary"]) for row in rows]

    def get(self, connection: Connection, workflow_id: UUID) -> WorkflowDocumentLocation:
        row = connection.execute(
            "SELECT id, revision, document_key, document FROM workflows WHERE id = %s",
            (workflow_id,),
        ).fetchone()
        if row is None:
            raise WorkflowNotFoundError
        return _document_location(row)

    def lock(self, connection: Connection, workflow_id: UUID) -> WorkflowDocumentLocation:
        row = connection.execute(
            """
            SELECT id, revision, document_key, document
              FROM workflows
             WHERE id = %s
             FOR UPDATE
            """,
            (workflow_id,),
        ).fetchone()
        if row is None:
            raise WorkflowNotFoundError
        return _document_location(row)

    def get_scoped(
        self, connection: Connection, namespace_id: UUID, workflow_id: UUID
    ) -> WorkflowDocumentLocation:
        row = connection.execute(
            """
            SELECT id, revision, document_key, document FROM workflows
             WHERE namespace_id = %s AND id = %s
            """,
            (namespace_id, workflow_id),
        ).fetchone()
        if row is None:
            raise ScopedWorkflowNotFoundError
        return _document_location(row)

    def lock_scoped(
        self, connection: Connection, namespace_id: UUID, workflow_id: UUID
    ) -> WorkflowDocumentLocation:
        row = connection.execute(
            """
            SELECT id, revision, document_key, document FROM workflows
             WHERE namespace_id = %s AND id = %s
             FOR UPDATE
            """,
            (namespace_id, workflow_id),
        ).fetchone()
        if row is None:
            raise ScopedWorkflowNotFoundError
        return _document_location(row)

    def insert(
        self,
        connection: Connection,
        workflow: Workflow,
        summary: WorkflowSummary,
        document_key: str,
        *,
        namespace_id: UUID,
    ) -> None:
        connection.execute(
            """
            INSERT INTO workflows (
                id, revision, status, created_at, updated_at, finished_at,
                document, document_key, summary, namespace_id
            ) VALUES (%s, %s, %s, %s, %s, %s, NULL, %s, %s, %s)
            """,
            (
                workflow.id,
                workflow.revision,
                workflow.status,
                workflow.created_at,
                workflow.updated_at,
                workflow.finished_at,
                document_key,
                Jsonb(_model_json(summary)),
                namespace_id,
            ),
        )

    def update(
        self,
        connection: Connection,
        workflow: Workflow,
        summary: WorkflowSummary,
        document_key: str,
        *,
        expected_revision: int,
    ) -> None:
        cursor = connection.execute(
            """
            UPDATE workflows
               SET revision = %s,
                   status = %s,
                   updated_at = %s,
                   finished_at = %s,
                   document = NULL,
                   document_key = %s,
                   summary = %s
             WHERE id = %s
               AND revision = %s
            """,
            (
                workflow.revision,
                workflow.status,
                workflow.updated_at,
                workflow.finished_at,
                document_key,
                Jsonb(_model_json(summary)),
                workflow.id,
                expected_revision,
            ),
        )
        if cursor.rowcount != 1:
            raise RevisionConflictError

    def update_scoped(
        self,
        connection: Connection,
        workflow: Workflow,
        summary: WorkflowSummary,
        document_key: str,
        *,
        namespace_id: UUID,
        expected_revision: int,
    ) -> None:
        cursor = connection.execute(
            """
            UPDATE workflows
               SET revision = %s, status = %s, updated_at = %s, finished_at = %s,
                   document = NULL, document_key = %s, summary = %s
             WHERE namespace_id = %s AND id = %s AND revision = %s
            """,
            (
                workflow.revision,
                workflow.status,
                workflow.updated_at,
                workflow.finished_at,
                document_key,
                Jsonb(_model_json(summary)),
                namespace_id,
                workflow.id,
                expected_revision,
            ),
        )
        if cursor.rowcount != 1:
            raise RevisionConflictError

    def list_legacy_documents(
        self,
        connection: Connection,
        *,
        limit: int,
    ) -> list[LegacyWorkflowDocument]:
        rows = connection.execute(
            """
            SELECT id, revision, document
              FROM workflows
             WHERE document_key IS NULL
             ORDER BY id
             LIMIT %s
            """,
            (limit,),
        ).fetchall()
        documents = []
        for row in rows:
            workflow = _validate_document(row["document"], row["id"], row["revision"])
            documents.append(LegacyWorkflowDocument(workflow=workflow, revision=row["revision"]))
        return documents

    def publish_backfilled_document(
        self,
        connection: Connection,
        *,
        workflow_id: UUID,
        revision: int,
        document_key: str,
    ) -> bool:
        cursor = connection.execute(
            """
            UPDATE workflows
               SET document = NULL,
                   document_key = %s
             WHERE id = %s
               AND revision = %s
               AND document_key IS NULL
            """,
            (document_key, workflow_id, revision),
        )
        return cursor.rowcount == 1


def _document_location(row: dict[str, Any]) -> WorkflowDocumentLocation:
    document = row["document"]
    return WorkflowDocumentLocation(
        workflow_id=row["id"],
        revision=row["revision"],
        object_key=row["document_key"],
        legacy_document=(
            _validate_document(document, row["id"], row["revision"])
            if document is not None
            else None
        ),
    )


def _validate_document(document: Any, workflow_id: UUID, revision: int) -> Workflow:
    try:
        workflow = Workflow.model_validate(document)
    except ValidationError as error:
        raise InternalPersistenceError from error
    if workflow.id != workflow_id or workflow.revision != revision:
        raise InternalPersistenceError
    return workflow


def _model_json(model: WorkflowSummary) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)
