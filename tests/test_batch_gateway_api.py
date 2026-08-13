from __future__ import annotations

import base64
import json
from collections.abc import Iterator

import httpx2
import pytest
from fastapi.testclient import TestClient

from relay_backend.main import create_app
from relay_backend.settings import Settings
from tests.conftest import DATABASE_URL

WORKFLOW_ID = "b4749f7e-4b22-43bf-8ef4-8ba5f79cb17b"
ARTIFACT_ID = "11111111-1111-4111-8111-111111111111"
BATCH_ID = "22222222-2222-4222-8222-222222222222"


class StubWorkflowService:
    pass


class RecordingStream(httpx2.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


def byte_stream(content: bytes) -> RecordingStream:
    return RecordingStream([content])


def settings() -> Settings:
    return Settings(
        database_url=DATABASE_URL,
        basic_auth_username="relay",
        basic_auth_password="test-password",
        bucket="relay-workflows",
        endpoint="https://storage.railway.app",
        access_key_id="test-access-key",
        secret_access_key="test-secret-key",
        region="auto",
        automation_service_url="http://automation.internal:8080",
        _env_file=None,
    )


def authenticated_client(handler) -> Iterator[TestClient]:
    automation_client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    app = create_app(
        settings=settings(),
        service=StubWorkflowService(),
        automation_client=automation_client,
    )
    token = base64.b64encode(b"relay:test-password").decode()
    with TestClient(app, headers={"Authorization": f"Basic {token}"}) as client:
        yield client


def test_batch_creation_requires_authentication_before_contacting_automation() -> None:
    contacted = False

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        nonlocal contacted
        contacted = True
        return httpx2.Response(500)

    automation_client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    app = create_app(
        settings=settings(),
        service=StubWorkflowService(),
        automation_client=automation_client,
    )
    with TestClient(app) as client:
        response = client.post("/v1/batches", json={"runs": [{"workflow": {}}]})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
    assert contacted is False


def test_batch_creation_forwards_opaque_workflows_once_and_preserves_response() -> None:
    captured: list[dict] = []
    workflows = [
        {"schemaVersion": "1.2", "localOnly": {"target": "private"}},
        {"schemaVersion": "1.4", "workspace": {"kind": "Local"}},
    ]

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        captured.append(
            {
                "method": request.method,
                "url": str(request.url),
                "headers": dict(request.headers),
                "body": json.loads(request.content),
            }
        )
        return httpx2.Response(
            202,
            headers={
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Private-Upstream": "must-not-pass",
            },
            stream=byte_stream(
                json.dumps({"batchId": BATCH_ID, "runCount": len(workflows)}).encode()
            ),
        )

    client_iterator = authenticated_client(upstream)
    client = next(client_iterator)
    try:
        response = client.post(
            "/v1/batches",
            headers={"Accept": "application/json"},
            json={"runs": [{"workflow": workflow} for workflow in workflows]},
        )
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 202
    assert response.json() == {"batchId": BATCH_ID, "runCount": 2}
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "x-private-upstream" not in response.headers
    assert len(captured) == 1
    assert captured[0]["method"] == "POST"
    assert captured[0]["url"] == "http://automation.internal:8080/v1/batches"
    assert captured[0]["body"] == {"runs": [{"workflow": workflow} for workflow in workflows]}
    assert captured[0]["headers"]["accept"] == "application/json"
    assert captured[0]["headers"]["content-type"] == "application/json"


def test_batch_polling_requires_authentication_before_contacting_automation() -> None:
    contacted = False

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        nonlocal contacted
        contacted = True
        return httpx2.Response(500)

    automation_client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    app = create_app(
        settings=settings(),
        service=StubWorkflowService(),
        automation_client=automation_client,
    )
    with TestClient(app) as client:
        response = client.get(f"/v1/batches/{BATCH_ID}")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
    assert contacted is False


def test_batch_polling_preserves_the_safe_snapshot() -> None:
    snapshot = {
        "batchId": BATCH_ID,
        "runs": [
            {"workflowId": WORKFLOW_ID, "status": "queued"},
            {
                "workflowId": "33333333-3333-4333-8333-333333333333",
                "status": "running",
                "currentStep": 2,
                "totalSteps": 5,
                "passedSteps": 1,
                "skippedSteps": 0,
                "phase": "acting",
            },
            {
                "workflowId": "44444444-4444-4444-8444-444444444444",
                "status": "completed",
                "durationMs": 1200,
                "thumbnail": {
                    "url": f"/v1/artifacts/{ARTIFACT_ID}",
                    "mediaType": "image/webp",
                    "width": 480,
                    "height": 300,
                    "expiresAt": "2026-08-13T12:00:00Z",
                },
            },
            {
                "workflowId": "55555555-5555-4555-8555-555555555555",
                "status": "failed",
                "failedStepId": "submit",
                "failedStepIndex": 3,
                "code": "assertion_failed",
            },
        ],
    }

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        assert request.method == "GET"
        assert str(request.url) == f"http://automation.internal:8080/v1/batches/{BATCH_ID}"
        return httpx2.Response(
            200,
            headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
            stream=byte_stream(json.dumps(snapshot).encode()),
        )

    client_iterator = authenticated_client(upstream)
    client = next(client_iterator)
    try:
        response = client.get(f"/v1/batches/{BATCH_ID}")
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 200
    assert response.json() == snapshot
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"runs": []}, id="empty"),
        pytest.param(
            {"runs": [{"workflow": {}} for _ in range(11)]},
            id="more-than-ten",
        ),
        pytest.param(
            {"runs": [{"workflow": {}}], "unexpected": True},
            id="extra-envelope-field",
        ),
        pytest.param(
            {"runs": [{"workflow": {}, "unexpected": True}]},
            id="extra-run-field",
        ),
        pytest.param({"runs": [{"workflow": []}]}, id="workflow-is-not-object"),
    ],
)
def test_batch_creation_rejects_invalid_public_envelopes(body: dict) -> None:
    contacted = False

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        nonlocal contacted
        contacted = True
        return httpx2.Response(500)

    client_iterator = authenticated_client(upstream)
    client = next(client_iterator)
    try:
        response = client.post("/v1/batches", json=body)
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"
    assert contacted is False


def test_batch_creation_rejects_an_oversized_request_without_contacting_upstream() -> None:
    contacted = False

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        nonlocal contacted
        contacted = True
        return httpx2.Response(500)

    client_iterator = authenticated_client(upstream)
    client = next(client_iterator)
    try:
        response = client.post(
            "/v1/batches",
            content=json.dumps({"runs": [{"workflow": {"payload": "x" * 1_048_576}}]}),
            headers={"Content-Type": "application/json"},
        )
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "validation_failed"
    assert contacted is False


def test_batch_polling_rejects_a_malformed_uuid_without_contacting_upstream() -> None:
    contacted = False

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        nonlocal contacted
        contacted = True
        return httpx2.Response(500)

    client_iterator = authenticated_client(upstream)
    client = next(client_iterator)
    try:
        response = client.get("/v1/batches/not-a-uuid")
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "validation_failed"
    assert contacted is False


@pytest.mark.parametrize("status", [404, 429, 500, 503])
def test_batch_routes_preserve_safe_upstream_failures_and_allowlisted_headers(
    status: int,
) -> None:
    content = json.dumps({"error": {"code": f"safe_{status}", "message": "Safe failure."}}).encode()

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            status,
            headers={
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "Retry-After": "9",
                "X-Content-Type-Options": "nosniff",
                "Set-Cookie": "private=true",
                "X-Upstream-Internal": "private",
            },
            stream=byte_stream(content),
        )

    client_iterator = authenticated_client(upstream)
    client = next(client_iterator)
    try:
        response = client.get(f"/v1/batches/{BATCH_ID}")
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == status
    assert response.content == content
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["retry-after"] == "9"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "set-cookie" not in response.headers
    assert "x-upstream-internal" not in response.headers


@pytest.mark.parametrize(
    "error_type",
    [httpx2.ConnectError, httpx2.ReadTimeout, httpx2.RemoteProtocolError],
)
def test_batch_creation_converts_pre_header_transport_failures_without_retrying(
    error_type: type[httpx2.RequestError],
) -> None:
    attempts = 0

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        nonlocal attempts
        attempts += 1
        raise error_type("private upstream detail", request=request)

    client_iterator = authenticated_client(upstream)
    client = next(client_iterator)
    try:
        response = client.post("/v1/batches", json={"runs": [{"workflow": {}}]})
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "automation_unavailable"
    assert attempts == 1


def test_batch_polling_converts_a_stalled_upstream_read_to_safe_unavailable() -> None:
    class StalledStream(httpx2.AsyncByteStream):
        async def __aiter__(self):
            yield b'{"batchId":"partial'
            raise httpx2.ReadTimeout("private timeout")

        async def aclose(self) -> None:
            return None

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            headers={"Content-Type": "application/json"},
            stream=StalledStream(),
        )

    client_iterator = authenticated_client(upstream)
    client = next(client_iterator)
    try:
        response = client.get(f"/v1/batches/{BATCH_ID}")
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "automation_unavailable"
    assert b"partial" not in response.content


def test_batch_polling_rejects_an_oversized_upstream_response() -> None:
    stream = RecordingStream([b"x" * 1_048_576, b"y"])

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, stream=stream)

    client_iterator = authenticated_client(upstream)
    client = next(client_iterator)
    try:
        response = client.get(f"/v1/batches/{BATCH_ID}")
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "automation_unavailable"
    assert stream.closed is True


@pytest.mark.parametrize(
    ("method", "path", "body", "safe_path"),
    [
        pytest.param(
            "POST",
            "/v1/batches",
            {"runs": [{"workflow": {"payload": "private-payload"}}]},
            "/v1/batches",
            id="creation",
        ),
        pytest.param(
            "GET",
            f"/v1/batches/{BATCH_ID}",
            None,
            "/v1/batches/{batchId}",
            id="polling",
        ),
    ],
)
def test_unexpected_batch_errors_log_no_payload_ids_or_private_urls(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    body: dict | None,
    safe_path: str,
) -> None:
    class BrokenAutomationClient:
        def stream(self, *args, **kwargs):
            raise RuntimeError("http://automation.internal:8080/private-detail")

    log_messages: list[str] = []

    def record_log(message: str, *args) -> None:
        log_messages.append(message % args)

    monkeypatch.setattr("relay_backend.main.logger.error", record_log)
    app = create_app(
        settings=settings(),
        service=StubWorkflowService(),
        automation_client=BrokenAutomationClient(),
    )
    token = base64.b64encode(b"relay:test-password").decode()
    with TestClient(
        app,
        headers={"Authorization": f"Basic {token}"},
        raise_server_exceptions=False,
    ) as client:
        response = client.request(method, path, json=body)

    logged = "".join(log_messages)
    assert response.status_code == 500
    assert "private-payload" not in logged
    assert BATCH_ID not in logged
    assert "automation.internal" not in logged
    assert log_messages == [f"Unhandled RuntimeError during {method} {safe_path}"]
