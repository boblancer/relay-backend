from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg import Connection
from psycopg.types.json import Jsonb

from relay_backend.errors import (
    IdempotencyConflictError,
    InternalPersistenceError,
    RevisionConflictError,
    WorkflowNotFoundError,
)
from relay_backend.models.workflows import Workflow, WorkflowSummary


@dataclass(frozen=True)
class IdempotencyReplay:
    status: int
    body: dict[str, Any]


@dataclass(frozen=True)
class WorkflowDocumentLocation:
    object_key: str | None
    legacy_document: Workflow | None


class WorkflowRepository:
    def list_summaries(self, connection: Connection) -> list[WorkflowSummary]:
        rows = connection.execute(
            "SELECT summary FROM workflows ORDER BY updated_at DESC"
        ).fetchall()
        return [WorkflowSummary.model_validate(row["summary"]) for row in rows]

    def get(self, connection: Connection, workflow_id: UUID) -> WorkflowDocumentLocation:
        row = connection.execute(
            "SELECT document_key, document FROM workflows WHERE id = %s",
            (workflow_id,),
        ).fetchone()
        if row is None:
            raise WorkflowNotFoundError
        return _document_location(row)

    def lock(self, connection: Connection, workflow_id: UUID) -> WorkflowDocumentLocation:
        row = connection.execute(
            "SELECT document_key, document FROM workflows WHERE id = %s FOR UPDATE",
            (workflow_id,),
        ).fetchone()
        if row is None:
            raise WorkflowNotFoundError
        return _document_location(row)

    def insert(
        self,
        connection: Connection,
        workflow: Workflow,
        summary: WorkflowSummary,
        document_key: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO workflows (
                id, revision, status, created_at, updated_at, finished_at,
                document, document_key, summary
            ) VALUES (%s, %s, %s, %s, %s, %s, NULL, %s, %s)
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

    def claim_idempotency(
        self,
        connection: Connection,
        *,
        key: UUID,
        method: str,
        path: str,
        request_hash: bytes,
    ) -> IdempotencyReplay | None:
        claimed = connection.execute(
            """
            INSERT INTO idempotency_records (key, method, path, request_hash)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (key) DO NOTHING
            RETURNING key
            """,
            (key, method, path, request_hash),
        ).fetchone()
        if claimed is not None:
            return None

        existing = connection.execute(
            """
            SELECT method, path, request_hash, response_status, response_body
              FROM idempotency_records
             WHERE key = %s
            """,
            (key,),
        ).fetchone()
        if existing is None:
            raise InternalPersistenceError
        if (
            existing["method"] != method
            or existing["path"] != path
            or bytes(existing["request_hash"]) != request_hash
        ):
            raise IdempotencyConflictError
        if existing["response_status"] is None or existing["response_body"] is None:
            raise InternalPersistenceError
        return IdempotencyReplay(
            status=existing["response_status"],
            body=existing["response_body"],
        )

    def complete_idempotency(
        self,
        connection: Connection,
        *,
        key: UUID,
        status: int,
        body: dict[str, Any],
    ) -> None:
        cursor = connection.execute(
            """
            UPDATE idempotency_records
               SET response_status = %s,
                   response_body = %s
             WHERE key = %s
               AND response_status IS NULL
            """,
            (status, Jsonb(body), key),
        )
        if cursor.rowcount != 1:
            raise InternalPersistenceError


def _document_location(row: dict[str, Any]) -> WorkflowDocumentLocation:
    document = row["document"]
    return WorkflowDocumentLocation(
        object_key=row["document_key"],
        legacy_document=Workflow.model_validate(document) if document is not None else None,
    )


def _model_json(model: WorkflowSummary) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)
