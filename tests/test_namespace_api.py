from __future__ import annotations

import base64
from collections.abc import Iterator
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from relay_backend.data.database import Database
from relay_backend.main import create_app
from relay_backend.services.workflows import WorkflowService
from relay_backend.settings import Settings
from tests.conftest import DATABASE_URL
from tests.fakes import InMemoryWorkflowDocumentStore
from tests.test_models import workflow_document


@pytest.fixture
def namespace_client() -> Iterator[tuple[TestClient, InMemoryWorkflowDocumentStore]]:
    database = Database(DATABASE_URL, min_size=1, max_size=6)
    database.open()
    document_store = InMemoryWorkflowDocumentStore()
    service = WorkflowService(
        database,
        document_store,
        clock=lambda: datetime(2026, 8, 11, 12, tzinfo=UTC),
    )
    settings = Settings(
        database_url=DATABASE_URL,
        basic_auth_username="relay",
        basic_auth_password="test-password",
        bucket="relay-workflows",
        endpoint="https://storage.railway.app",
        access_key_id="test-access-key",
        secret_access_key="test-secret-key",
        region="auto",
        _env_file=None,
    )
    token = base64.b64encode(b"relay:test-password").decode()
    try:
        with TestClient(
            create_app(settings=settings, service=service),
            headers={"Authorization": f"Basic {token}"},
        ) as client:
            yield client, document_store
    finally:
        database.close()


def test_namespace_create_replay_list_and_get(
    namespace_client: tuple[TestClient, InMemoryWorkflowDocumentStore],
) -> None:
    client, document_store = namespace_client
    key = str(uuid4())

    created = client.post(
        "/v1/namespaces",
        headers={"Idempotency-Key": key},
        json={"name": "  Acme  "},
    )
    replayed = client.post(
        "/v1/namespaces",
        headers={"Idempotency-Key": key},
        json={"name": "Acme"},
    )
    listed = client.get("/v1/namespaces")
    loaded = client.get(f"/v1/namespaces/{created.json()['id']}")

    assert created.status_code == replayed.status_code == 201
    assert replayed.json() == created.json()
    assert created.json()["name"] == "Acme"
    assert [item["name"] for item in listed.json()["namespaces"]] == ["Acme", "Default"]
    assert loaded.json() == created.json()
    assert document_store.put_calls == document_store.get_calls == 0


def test_namespace_validation_duplicate_and_safe_missing_errors(
    namespace_client: tuple[TestClient, InMemoryWorkflowDocumentStore],
) -> None:
    client, _ = namespace_client
    first = client.post(
        "/v1/namespaces",
        headers={"Idempotency-Key": str(uuid4())},
        json={"name": "Acme"},
    )
    reusable_key = str(uuid4())
    duplicate = client.post(
        "/v1/namespaces",
        headers={"Idempotency-Key": reusable_key},
        json={"name": "Acme"},
    )
    recovered = client.post(
        "/v1/namespaces",
        headers={"Idempotency-Key": reusable_key},
        json={"name": "Recovered"},
    )
    invalid = client.post(
        "/v1/namespaces",
        headers={"Idempotency-Key": str(uuid4())},
        json={"name": "   "},
    )
    missing = client.get(f"/v1/namespaces/{uuid4()}")

    assert first.status_code == 201
    assert duplicate.status_code == 409
    assert duplicate.json() == {
        "error": {
            "code": "namespace_conflict",
            "message": "A namespace with that name already exists.",
        }
    }
    assert recovered.status_code == 201
    assert invalid.status_code == 400
    assert invalid.json()["error"]["message"] == "The namespace request is invalid."
    assert missing.status_code == 404
    assert missing.json()["error"]["message"] == "The namespace was not found."


def test_namespace_routes_require_shared_authentication(
    namespace_client: tuple[TestClient, InMemoryWorkflowDocumentStore],
) -> None:
    client, _ = namespace_client
    client.headers.pop("Authorization")

    response = client.get("/v1/namespaces")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_nested_workflows_are_scoped_and_alias_paths_have_distinct_idempotency(
    namespace_client: tuple[TestClient, InMemoryWorkflowDocumentStore],
) -> None:
    client, document_store = namespace_client
    left = client.post(
        "/v1/namespaces",
        headers={"Idempotency-Key": str(uuid4())},
        json={"name": "Left"},
    ).json()
    right = client.post(
        "/v1/namespaces",
        headers={"Idempotency-Key": str(uuid4())},
        json={"name": "Right"},
    ).json()
    create_key = str(uuid4())
    created = client.post(
        f"/v1/namespaces/{left['id']}/workflows",
        headers={"Idempotency-Key": create_key},
    )

    correct = client.get(f"/v1/namespaces/{left['id']}/workflows/{created.json()['id']}")
    wrong_reads = document_store.get_calls
    wrong = client.get(f"/v1/namespaces/{right['id']}/workflows/{created.json()['id']}")
    alias_conflict = client.post(
        "/v1/workflows",
        headers={"Idempotency-Key": create_key},
    )

    assert created.status_code == 201
    assert correct.json() == created.json()
    assert wrong.status_code == 404
    assert wrong.json()["error"]["message"] == "The namespace or workflow was not found."
    assert document_store.get_calls == wrong_reads
    assert alias_conflict.status_code == 409
    assert alias_conflict.json()["error"]["code"] == "idempotency_conflict"


def test_nested_save_finish_and_cross_scope_mutation(
    namespace_client: tuple[TestClient, InMemoryWorkflowDocumentStore],
) -> None:
    client, document_store = namespace_client
    namespace = client.post(
        "/v1/namespaces",
        headers={"Idempotency-Key": str(uuid4())},
        json={"name": "Owned"},
    ).json()
    other = client.post(
        "/v1/namespaces",
        headers={"Idempotency-Key": str(uuid4())},
        json={"name": "Other"},
    ).json()
    created = client.post(
        f"/v1/namespaces/{namespace['id']}/workflows",
        headers={"Idempotency-Key": str(uuid4())},
    ).json()
    document = workflow_document()
    document.update(
        {
            "id": created["id"],
            "revision": created["revision"],
            "status": created["status"],
            "createdAt": created["createdAt"],
            "updatedAt": created["updatedAt"],
        }
    )
    payload = {"workflow": document, "expectedRevision": 1}

    writes_before_wrong_scope = document_store.put_calls
    wrong = client.put(
        f"/v1/namespaces/{other['id']}/workflows/{created['id']}",
        headers={"Idempotency-Key": str(uuid4())},
        json=payload,
    )
    saved = client.put(
        f"/v1/namespaces/{namespace['id']}/workflows/{created['id']}",
        headers={"Idempotency-Key": str(uuid4())},
        json=payload,
    )
    finish_payload = {"workflow": saved.json(), "expectedRevision": 2}
    finished = client.post(
        f"/v1/namespaces/{namespace['id']}/workflows/{created['id']}/finish",
        headers={"Idempotency-Key": str(uuid4())},
        json=finish_payload,
    )

    assert wrong.status_code == 404
    assert document_store.put_calls == writes_before_wrong_scope + 2
    assert saved.json()["revision"] == 2
    assert finished.json()["revision"] == 3
    assert finished.json()["status"] == "complete"
