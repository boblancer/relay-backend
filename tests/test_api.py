from __future__ import annotations

import base64
import json
from collections.abc import Iterator
from copy import deepcopy
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from relay_backend import contract as contracts
from relay_backend.data.database import Database
from relay_backend.main import create_app
from relay_backend.services.workflows import WorkflowService
from relay_backend.settings import Settings
from tests.conftest import DATABASE_URL
from tests.test_models import workflow_document

MAX_REQUEST_BYTES = 1_048_576


@pytest.fixture
def client() -> Iterator[TestClient]:
    database = Database(DATABASE_URL, min_size=1, max_size=6)
    database.open()
    service = WorkflowService(
        database,
        clock=lambda: datetime(2026, 7, 30, 12, tzinfo=UTC),
    )
    settings = Settings(
        database_url=DATABASE_URL,
        basic_auth_username="relay",
        basic_auth_password="test-password",
        _env_file=None,
    )
    token = base64.b64encode(b"relay:test-password").decode()
    app = create_app(settings=settings, service=service)
    try:
        with TestClient(
            app,
            headers={"Authorization": f"Basic {token}"},
        ) as test_client:
            yield test_client
    finally:
        database.close()


def save_payload(created: dict) -> dict:
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
    return {"workflow": document, "expectedRevision": created["revision"]}


def test_settings_reject_an_empty_shared_password() -> None:
    with pytest.raises(ValidationError):
        Settings(
            database_url=DATABASE_URL,
            basic_auth_username="relay",
            basic_auth_password="",
            _env_file=None,
        )


def test_settings_ignore_dotenv_local(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / ".env").write_text(
        "DATABASE_URL=postgresql://relay:relay@localhost:5432/relay\n"
        "BASIC_AUTH_USERNAME=relay\n"
        "BASIC_AUTH_PASSWORD=relay-password\n",
        encoding="utf-8",
    )
    (tmp_path / ".env.local").write_text(
        "DATABASE_URL=postgresql://relay:relay@localhost:5432/relay\n"
        "BASIC_AUTH_USERNAME=local-relay\n"
        "BASIC_AUTH_PASSWORD=local-password\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("BASIC_AUTH_USERNAME", raising=False)
    monkeypatch.delenv("BASIC_AUTH_PASSWORD", raising=False)

    settings = Settings()

    assert settings.basic_auth_username == "relay"
    assert settings.basic_auth_password.get_secret_value() == "relay-password"


def test_api_requires_shared_basic_credentials(client: TestClient) -> None:
    client.headers.pop("Authorization")

    missing = client.get("/v1/workflows")
    wrong = client.get("/v1/workflows", auth=("relay", "wrong-password"))
    malformed = client.get(
        "/v1/workflows",
        headers={"Authorization": "Basic not-base64"},
    )

    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert malformed.status_code == 401
    assert missing.headers["www-authenticate"] == "Basic"
    assert missing.json() == {
        "error": {
            "code": "unauthorized",
            "message": "Authentication is required.",
        }
    }
    assert wrong.json() == missing.json()
    assert malformed.json() == missing.json()


def test_create_get_and_list_follow_the_contract(client: TestClient) -> None:
    missing_key = client.post("/v1/workflows")
    created_response = client.post(
        "/v1/workflows",
        headers={"Idempotency-Key": str(uuid4())},
    )

    assert missing_key.status_code == 400
    assert missing_key.json()["error"]["code"] == "validation_failed"
    assert created_response.status_code == 201
    created = created_response.json()
    assert created["name"] == "Untitled recording"
    assert created["revision"] == 1

    loaded = client.get(f"/v1/workflows/{created['id']}")
    listed = client.get("/v1/workflows")

    assert loaded.status_code == 200
    assert loaded.json() == created
    assert listed.status_code == 200
    assert listed.json() == {
        "workflows": [
            {
                "id": created["id"],
                "name": "Untitled recording",
                "status": "draft",
                "updatedAt": created["updatedAt"],
                "steps": [],
            }
        ]
    }


def test_create_rejects_an_unexpected_body_without_consuming_the_key(
    client: TestClient,
) -> None:
    key = str(uuid4())

    rejected = client.post(
        "/v1/workflows",
        headers={"Idempotency-Key": key},
        json={"unexpected": "sensitive-value"},
    )
    retried = client.post(
        "/v1/workflows",
        headers={"Idempotency-Key": key},
    )

    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "validation_failed"
    assert "sensitive-value" not in rejected.text
    assert retried.status_code == 201


def test_save_maps_revision_and_idempotency_conflicts(client: TestClient) -> None:
    created = client.post(
        "/v1/workflows",
        headers={"Idempotency-Key": str(uuid4())},
    ).json()
    payload = save_payload(created)
    save_key = str(uuid4())

    saved = client.put(
        f"/v1/workflows/{created['id']}",
        headers={"Idempotency-Key": save_key},
        json=payload,
    )
    replayed = client.put(
        f"/v1/workflows/{created['id']}",
        headers={"Idempotency-Key": save_key},
        json=payload,
    )
    changed_payload = deepcopy(payload)
    changed_payload["workflow"]["name"] = "Different request"
    key_conflict = client.put(
        f"/v1/workflows/{created['id']}",
        headers={"Idempotency-Key": save_key},
        json=changed_payload,
    )
    stale_payload = save_payload(saved.json())
    stale_payload["expectedRevision"] = 1
    revision_conflict = client.put(
        f"/v1/workflows/{created['id']}",
        headers={"Idempotency-Key": str(uuid4())},
        json=stale_payload,
    )

    assert saved.status_code == 200
    assert saved.json()["revision"] == 2
    assert replayed.json() == saved.json()
    assert key_conflict.status_code == 409
    assert key_conflict.json()["error"]["code"] == "idempotency_conflict"
    assert revision_conflict.status_code == 409
    assert revision_conflict.json()["error"]["code"] == "revision_conflict"


def test_validation_errors_are_safe_and_never_use_422(client: TestClient) -> None:
    invalid_uuid = client.get("/v1/workflows/not-a-uuid")
    body = {"secretExtra": "do-not-echo"}
    invalid_body = client.put(
        f"/v1/workflows/{uuid4()}",
        headers={"Idempotency-Key": str(uuid4())},
        json=body,
    )

    assert invalid_uuid.status_code == 400
    assert invalid_body.status_code == 400
    assert invalid_body.json() == {
        "error": {
            "code": "validation_failed",
            "message": "The workflow request is invalid.",
        }
    }
    assert "do-not-echo" not in invalid_body.text


def test_missing_workflow_returns_contract_not_found(client: TestClient) -> None:
    response = client.get(f"/v1/workflows/{uuid4()}")

    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "not_found",
            "message": "The workflow was not found.",
        }
    }


def test_finish_requires_at_least_one_step(client: TestClient) -> None:
    created = client.post(
        "/v1/workflows",
        headers={"Idempotency-Key": str(uuid4())},
    ).json()

    response = client.post(
        f"/v1/workflows/{created['id']}/finish",
        headers={"Idempotency-Key": str(uuid4())},
        json={"workflow": created, "expectedRevision": 1},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"
    assert "step" in response.json()["error"]["message"].lower()


def test_request_body_limit_accepts_exact_boundary_and_rejects_one_more_byte(
    client: TestClient,
) -> None:
    created = client.post(
        "/v1/workflows",
        headers={"Idempotency-Key": str(uuid4())},
    ).json()
    payload = save_payload(created)
    payload["workflow"]["steps"][1]["payload"]["url"] = ""
    compact = json.dumps(payload, separators=(",", ":"))
    padding = "x" * (MAX_REQUEST_BYTES - len(compact))
    payload["workflow"]["steps"][1]["payload"]["url"] = padding
    exact_body = json.dumps(payload, separators=(",", ":")).encode()
    assert len(exact_body) == MAX_REQUEST_BYTES

    accepted = client.put(
        f"/v1/workflows/{created['id']}",
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": str(uuid4()),
        },
        content=exact_body,
    )
    oversized = exact_body + b" "
    rejected = client.put(
        f"/v1/workflows/{created['id']}",
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": str(uuid4()),
        },
        content=oversized,
    )

    assert accepted.status_code == 200
    assert rejected.status_code == 413
    assert rejected.json()["error"]["code"] == "validation_failed"


def test_unavailable_pool_returns_safe_503() -> None:
    database = Database(DATABASE_URL, min_size=1, max_size=1)
    settings = Settings(
        database_url=DATABASE_URL,
        basic_auth_username="relay",
        basic_auth_password="test-password",
        _env_file=None,
    )
    app = create_app(settings=settings, service=WorkflowService(database))

    with TestClient(app, raise_server_exceptions=False) as unavailable_client:
        response = unavailable_client.get("/v1/workflows", auth=("relay", "test-password"))

    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "unavailable",
            "message": "Workflow storage is temporarily unavailable.",
        }
    }


def test_unexpected_failure_returns_safe_500() -> None:
    class ExplodingService:
        def list(self) -> None:
            raise RuntimeError("sensitive database detail")

    settings = Settings(
        database_url=DATABASE_URL,
        basic_auth_username="relay",
        basic_auth_password="test-password",
        _env_file=None,
    )
    app = create_app(settings=settings, service=ExplodingService())

    with TestClient(app, raise_server_exceptions=False) as exploding_client:
        response = exploding_client.get("/v1/workflows", auth=("relay", "test-password"))

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal"
    assert "sensitive database detail" not in response.text


def test_served_openapi_is_the_authenticated_repository_contract(client: TestClient) -> None:
    response = client.get("/openapi.json")

    assert response.status_code == 200
    contract = response.json()
    assert contract["openapi"] == "3.1.0"
    assert contract["security"] == [{"basicAuth": []}]
    assert contract["components"]["securitySchemes"]["basicAuth"] == {
        "type": "http",
        "scheme": "basic",
        "description": "Shared credentials configured by the backend operator.",
    }
    assert set(contract["paths"]) == {
        "/v1/workflows",
        "/v1/workflows/{workflowId}",
        "/v1/workflows/{workflowId}/finish",
    }


def test_automation_contract_loader_reads_the_run_service_contract() -> None:
    contract = contracts.load_automation_openapi_contract()

    assert contract["info"]["title"] == "Relay Browserbase Automation Service"
    assert "security" not in contract
    assert "securitySchemes" not in contract["components"]
    assert set(contract["paths"]) == {
        "/v1/run",
        "/v1/batches",
        "/v1/batches/{batchId}",
        "/v1/artifacts/{artifactId}",
        "/health/live",
        "/health/ready",
    }
    assert (
        contract["components"]["schemas"]["TerminalThumbnail"]["properties"]["mediaType"]["const"]
        == "image/webp"
    )
    assert "/api/inngest" not in contract["paths"]


def test_docs_use_scalar_and_disable_the_default_redoc(client: TestClient) -> None:
    docs = client.get("/docs")
    redoc = client.get("/redoc")

    assert docs.status_code == 200
    assert "scalar" in docs.text.lower()
    assert "<title>Relay API Reference</title>" in docs.text
    assert '"title": "Workflow Storage"' in docs.text
    assert '"slug": "workflow-storage"' in docs.text
    assert '"default": true' in docs.text
    assert '"title": "Workflow Runs"' in docs.text
    assert '"slug": "workflow-runs"' in docs.text
    assert '"/v1/run"' in docs.text
    assert '"bearerAuth"' not in docs.text
    assert "/api/inngest" not in docs.text
    assert "swagger-ui" not in docs.text.lower()
    assert '"agent": {"disabled": true}' in docs.text
    assert '"hideTestRequestButton": true' in docs.text
    assert '"showDeveloperTools": "never"' in docs.text
    assert redoc.status_code == 404
