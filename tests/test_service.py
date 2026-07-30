from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import UUID, uuid4

import psycopg
import pytest

from relay_backend.data.database import Database
from relay_backend.errors import (
    IdempotencyConflictError,
    RevisionConflictError,
    ValidationFailedError,
)
from relay_backend.models.workflows import SaveWorkflowRequest, Workflow, WorkflowStatus
from relay_backend.services.workflows import WorkflowService
from tests.conftest import DATABASE_URL
from tests.test_models import workflow_document


@pytest.fixture
def database() -> Database:
    instance = Database(DATABASE_URL, min_size=1, max_size=6)
    instance.open()
    try:
        yield instance
    finally:
        instance.close()


@pytest.fixture
def service(database: Database) -> WorkflowService:
    return WorkflowService(
        database,
        clock=lambda: datetime(2026, 7, 30, 12, tzinfo=UTC),
    )


def edited_request(workflow: Workflow, expected_revision: int | None = None) -> SaveWorkflowRequest:
    recorded = Workflow.model_validate(workflow_document())
    edited = workflow.model_copy(
        update={
            "name": "Recorded checkout",
            "source": recorded.source,
            "steps": recorded.steps,
        }
    )
    return SaveWorkflowRequest(
        workflow=edited,
        expected_revision=expected_revision or workflow.revision,
    )


def test_create_replays_the_original_workflow(service: WorkflowService) -> None:
    key = uuid4()

    created = service.create(key)
    replayed = service.create(key)

    assert replayed == created
    assert created.schema_version == "1.2"
    assert created.name == "Untitled recording"
    assert created.status == "draft"
    assert created.revision == 1
    assert created.source.provider == "browserbase"
    assert created.source.session_id == ""
    assert created.steps == []
    with psycopg.connect(DATABASE_URL) as connection:
        assert connection.execute("SELECT count(*) FROM workflows").fetchone() == (1,)
        assert connection.execute("SELECT count(*) FROM idempotency_records").fetchone() == (1,)


def test_save_preserves_server_fields_and_replays_before_revision_check(
    service: WorkflowService,
) -> None:
    created = service.create(uuid4())
    request = edited_request(created)
    request.workflow.status = WorkflowStatus.COMPLETE
    request.workflow.revision = 99
    request.workflow.created_at = datetime(2020, 1, 1, tzinfo=UTC)
    save_key = uuid4()

    saved = service.save(created.id, request, save_key)
    replayed = service.save(created.id, request, save_key)

    assert replayed == saved
    assert saved.id == created.id
    assert saved.status == "draft"
    assert saved.revision == 2
    assert saved.created_at == created.created_at
    assert saved.updated_at == datetime(2026, 7, 30, 12, tzinfo=UTC)


def test_finish_sets_lifecycle_once_and_requires_a_step(service: WorkflowService) -> None:
    created = service.create(uuid4())
    empty_request = SaveWorkflowRequest(workflow=created, expectedRevision=1)
    reusable_key = uuid4()

    with pytest.raises(ValidationFailedError):
        service.finish(created.id, empty_request, reusable_key)

    first = service.finish(created.id, edited_request(created), reusable_key)
    second = service.finish(
        created.id,
        SaveWorkflowRequest(workflow=first, expectedRevision=2),
        uuid4(),
    )

    assert first.status == "complete"
    assert first.revision == 2
    assert first.finished_at == datetime(2026, 7, 30, 12, tzinfo=UTC)
    assert second.status == "complete"
    assert second.revision == 3
    assert second.finished_at == first.finished_at


def test_failed_revision_does_not_consume_idempotency_key(service: WorkflowService) -> None:
    created = service.create(uuid4())
    key = uuid4()

    with pytest.raises(RevisionConflictError):
        service.save(created.id, edited_request(created, expected_revision=99), key)

    saved = service.save(created.id, edited_request(created), key)

    assert saved.revision == 2


def test_reusing_a_key_for_different_content_conflicts(service: WorkflowService) -> None:
    created = service.create(uuid4())
    key = uuid4()
    service.save(created.id, edited_request(created), key)
    changed = edited_request(created)
    changed.workflow.name = "Different edit"

    with pytest.raises(IdempotencyConflictError):
        service.save(created.id, changed, key)


def test_replay_after_later_mutation_returns_original_result_without_rewinding(
    service: WorkflowService,
) -> None:
    created = service.create(uuid4())
    first_request = edited_request(created)
    first_key = uuid4()
    first = service.save(created.id, first_request, first_key)
    second_request = SaveWorkflowRequest(
        workflow=first.model_copy(update={"name": "Later edit"}),
        expected_revision=2,
    )
    second = service.save(created.id, second_request, uuid4())

    replayed = service.save(created.id, first_request, first_key)

    assert replayed == first
    assert service.get(created.id) == second
    assert service.get(created.id).revision == 3


def test_idempotency_keys_are_global_across_mutation_paths(service: WorkflowService) -> None:
    created = service.create(uuid4())
    shared_key = uuid4()
    saved = service.save(created.id, edited_request(created), shared_key)

    with pytest.raises(IdempotencyConflictError):
        service.finish(
            created.id,
            SaveWorkflowRequest(workflow=saved, expected_revision=2),
            shared_key,
        )


def test_route_and_document_ids_must_match(service: WorkflowService) -> None:
    created = service.create(uuid4())

    with pytest.raises(ValidationFailedError):
        service.save(uuid4(), edited_request(created), uuid4())


def test_concurrent_saves_allow_exactly_one_revision_winner(
    service: WorkflowService,
) -> None:
    created = service.create(uuid4())
    left = edited_request(created)
    right = edited_request(created)
    right.workflow.name = "Competing edit"

    def attempt(request: SaveWorkflowRequest) -> Workflow | RevisionConflictError:
        try:
            return service.save(created.id, request, uuid4())
        except RevisionConflictError as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(attempt, (left, right)))

    assert sum(isinstance(outcome, Workflow) for outcome in outcomes) == 1
    assert sum(isinstance(outcome, RevisionConflictError) for outcome in outcomes) == 1
    assert service.get(created.id).revision == 2


def test_list_reads_safe_summaries_without_sensitive_document_values(
    service: WorkflowService,
) -> None:
    created = service.create(uuid4())
    saved = service.save(created.id, edited_request(created), uuid4())

    summaries = service.list()

    assert summaries.workflows[0].id == saved.id
    assert [step.order for step in summaries.workflows[0].steps] == [0, 1]
    assert "4111111111111111" not in repr(summaries)
    assert "sensitive-session" not in repr(summaries)
    assert service.get(UUID(str(created.id))).source.session_id == "sensitive-session"


def test_list_orders_workflows_by_most_recent_update(database: Database) -> None:
    timestamps = iter(
        (
            datetime(2026, 7, 30, 12, tzinfo=UTC),
            datetime(2026, 7, 30, 13, tzinfo=UTC),
        )
    )
    service = WorkflowService(database, clock=lambda: next(timestamps))
    older = service.create(uuid4())
    newer = service.create(uuid4())

    listed = service.list()

    assert [summary.id for summary in listed.workflows] == [newer.id, older.id]
