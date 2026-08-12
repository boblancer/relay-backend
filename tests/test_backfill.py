from __future__ import annotations

from uuid import uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb

from relay_backend.backfill_workflow_documents import backfill_workflow_documents
from relay_backend.data.database import Database
from relay_backend.errors import InternalPersistenceError, PersistenceUnavailableError
from relay_backend.models.workflows import Workflow, to_workflow_summary
from tests.conftest import DATABASE_URL
from tests.fakes import InMemoryWorkflowDocumentStore
from tests.test_models import workflow_document


@pytest.fixture
def database() -> Database:
    instance = Database(DATABASE_URL, min_size=1, max_size=3)
    instance.open()
    try:
        yield instance
    finally:
        instance.close()


def _insert_legacy_workflow(
    workflow: Workflow,
    *,
    row_id=None,
    row_revision: int | None = None,
) -> None:
    summary = to_workflow_summary(workflow)
    with psycopg.connect(DATABASE_URL) as connection:
        namespace_id = connection.execute(
            "SELECT id FROM namespaces WHERE name = 'Default'"
        ).fetchone()[0]
        connection.execute(
            """
            INSERT INTO workflows (
                id, revision, status, created_at, updated_at, finished_at,
                document, document_key, summary, namespace_id
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, NULL, %s, %s)
            """,
            (
                row_id or workflow.id,
                row_revision or workflow.revision,
                workflow.status,
                workflow.created_at,
                workflow.updated_at,
                workflow.finished_at,
                Jsonb(workflow.model_dump(mode="json", by_alias=True, exclude_none=True)),
                Jsonb(summary.model_dump(mode="json", by_alias=True, exclude_none=True)),
                namespace_id,
            ),
        )


def test_backfill_moves_legacy_documents_without_changing_metadata(
    database: Database,
) -> None:
    first = Workflow.model_validate(workflow_document()).model_copy(update={"id": uuid4()})
    second = first.model_copy(update={"id": uuid4(), "name": "Second workflow"})
    _insert_legacy_workflow(first)
    _insert_legacy_workflow(second)
    store = InMemoryWorkflowDocumentStore()

    result = backfill_workflow_documents(database, store, batch_size=1)

    assert result.migrated == 2
    assert result.skipped == 0
    with psycopg.connect(DATABASE_URL) as connection:
        rows = connection.execute(
            """
            SELECT id, revision, status, created_at, updated_at, finished_at,
                   document, document_key, summary
              FROM workflows
             ORDER BY id
            """
        ).fetchall()
    assert all(row[6] is None for row in rows)
    assert all(row[7] in store.objects for row in rows)
    assert {row[1] for row in rows} == {1}
    assert {row[3] for row in rows} == {first.created_at}
    assert {row[4] for row in rows} == {first.updated_at}
    assert {row[5] for row in rows} == {first.finished_at}
    assert {row[2] for row in rows} == {"draft"}
    summaries = {
        first.id: to_workflow_summary(first).model_dump(mode="json", by_alias=True),
        second.id: to_workflow_summary(second).model_dump(mode="json", by_alias=True),
    }
    assert all(row[8] == summaries[row[0]] for row in rows)

    replay = backfill_workflow_documents(database, store, batch_size=1)

    assert replay.migrated == 0
    assert replay.skipped == 0


def test_backfill_does_not_replace_a_concurrently_published_pointer(
    database: Database,
) -> None:
    workflow = Workflow.model_validate(workflow_document()).model_copy(update={"id": uuid4()})
    _insert_legacy_workflow(workflow)

    class ConcurrentStore(InMemoryWorkflowDocumentStore):
        def put(self, document: Workflow) -> str:
            object_key = super().put(document)
            with psycopg.connect(DATABASE_URL) as connection:
                connection.execute(
                    """
                    UPDATE workflows
                       SET document = NULL,
                           document_key = 'concurrent-object'
                     WHERE id = %s
                    """,
                    (document.id,),
                )
            return object_key

    result = backfill_workflow_documents(database, ConcurrentStore(), batch_size=10)

    assert result.migrated == 0
    assert result.skipped == 1
    with psycopg.connect(DATABASE_URL) as connection:
        row = connection.execute(
            "SELECT document, document_key FROM workflows WHERE id = %s",
            (workflow.id,),
        ).fetchone()
    assert row == (None, "concurrent-object")


def test_backfill_storage_failure_leaves_the_legacy_document_recoverable(
    database: Database,
) -> None:
    workflow = Workflow.model_validate(workflow_document()).model_copy(update={"id": uuid4()})
    _insert_legacy_workflow(workflow)
    store = InMemoryWorkflowDocumentStore()
    store.put_error = PersistenceUnavailableError()

    with pytest.raises(PersistenceUnavailableError):
        backfill_workflow_documents(database, store, batch_size=10)

    with psycopg.connect(DATABASE_URL) as connection:
        row = connection.execute(
            "SELECT document, document_key FROM workflows WHERE id = %s",
            (workflow.id,),
        ).fetchone()
    assert row[0] is not None
    assert row[1] is None


@pytest.mark.parametrize(
    ("row_id", "row_revision"),
    [
        (uuid4(), None),
        (None, 2),
    ],
)
def test_backfill_rejects_legacy_documents_that_disagree_with_their_row(
    database: Database,
    row_id,
    row_revision: int | None,
) -> None:
    workflow = Workflow.model_validate(workflow_document()).model_copy(update={"id": uuid4()})
    _insert_legacy_workflow(workflow, row_id=row_id, row_revision=row_revision)
    store = InMemoryWorkflowDocumentStore()

    with pytest.raises(InternalPersistenceError):
        backfill_workflow_documents(database, store)

    assert store.put_calls == 0
