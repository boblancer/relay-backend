from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Iterator
from pathlib import Path

import httpx2
import pytest
import yaml
from fastapi.testclient import TestClient

from relay_backend.errors import WorkflowNotFoundError
from relay_backend.main import create_app
from relay_backend.models.workflows import Workflow
from relay_backend.settings import Settings
from tests.conftest import DATABASE_URL
from tests.test_models import workflow_document

WORKFLOW_ID = "b4749f7e-4b22-43bf-8ef4-8ba5f79cb17b"
ARTIFACT_ID = "11111111-1111-4111-8111-111111111111"


class StubWorkflowService:
    def __init__(self, workflow: Workflow | None) -> None:
        self.workflow = workflow

    def get(self, workflow_id) -> Workflow:
        if self.workflow is None or workflow_id != self.workflow.id:
            raise WorkflowNotFoundError
        return self.workflow


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


def complete_workflow() -> Workflow:
    document = workflow_document()
    document["status"] = "complete"
    document["finishedAt"] = "2026-07-30T12:01:00Z"
    return Workflow.model_validate(document)


def authenticated_client(
    handler,
    *,
    workflow: Workflow | None = None,
) -> Iterator[tuple[TestClient, httpx2.AsyncClient]]:
    automation_client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    app = create_app(
        settings=settings(),
        service=StubWorkflowService(workflow or complete_workflow()),
        automation_client=automation_client,
    )
    token = base64.b64encode(b"relay:test-password").decode()
    with TestClient(app, headers={"Authorization": f"Basic {token}"}) as client:
        yield client, automation_client


def test_run_by_id_resolves_the_workflow_and_streams_the_existing_interface() -> None:
    captured: dict = {}
    stream = RecordingStream(
        [
            b'{"runId":"run-1","type":"step.started","stepIndex":0}\n',
            b'{"runId":"run-1","type":"worker.outcome","status":"completed"}\n',
        ]
    )

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return httpx2.Response(
            200,
            headers={
                "Content-Type": "application/x-ndjson",
                "X-Run-Id": "11111111-1111-4111-8111-111111111111",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
            stream=stream,
        )

    client_iterator = authenticated_client(upstream)
    client, _ = next(client_iterator)
    try:
        response = client.post(
            "/v1/run-by-id",
            headers={"Accept": "application/x-ndjson"},
            json={
                "workflowId": WORKFLOW_ID,
                "startStepId": "open-shop",
                "parameterValues": {"fill-card": "runtime-secret"},
            },
        )
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 200
    assert response.content == b"".join(stream.chunks)
    assert response.headers["content-type"] == "application/x-ndjson"
    assert response.headers["x-run-id"] == "11111111-1111-4111-8111-111111111111"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-accel-buffering"] == "no"
    assert captured["method"] == "POST"
    assert captured["url"] == "http://automation.internal:8080/v1/run"
    assert captured["headers"]["accept"] == "application/x-ndjson"
    assert captured["headers"]["content-type"] == "application/json"
    assert captured["body"] == {
        "workflow": complete_workflow().model_dump(mode="json", by_alias=True, exclude_none=True),
        "startStepId": "open-shop",
        "parameterValues": {"fill-card": "runtime-secret"},
    }
    assert stream.closed is True


def test_run_by_id_requires_authentication_before_contacting_automation() -> None:
    contacted = False

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        nonlocal contacted
        contacted = True
        return httpx2.Response(500)

    automation_client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    app = create_app(
        settings=settings(),
        service=StubWorkflowService(complete_workflow()),
        automation_client=automation_client,
    )
    with TestClient(app) as client:
        response = client.post("/v1/run-by-id", json={"workflowId": WORKFLOW_ID})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
    assert contacted is False


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"workflowId": "not-a-uuid"}, id="malformed-uuid"),
        pytest.param({"workflow_id": WORKFLOW_ID}, id="snake-case-field"),
        pytest.param(
            {"workflowId": WORKFLOW_ID, "unexpected": "value"},
            id="extra-field",
        ),
        pytest.param(
            {"workflowId": WORKFLOW_ID, "startStepId": None},
            id="null-start-step",
        ),
        pytest.param(
            {"workflowId": WORKFLOW_ID, "parameterValues": None},
            id="null-parameter-values",
        ),
    ],
)
def test_run_by_id_rejects_requests_outside_the_openapi_schema(body: dict) -> None:
    contacted = False

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        nonlocal contacted
        contacted = True
        return httpx2.Response(500)

    automation_client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    app = create_app(
        settings=settings(),
        service=StubWorkflowService(complete_workflow()),
        automation_client=automation_client,
    )
    token = base64.b64encode(b"relay:test-password").decode()
    with TestClient(app, headers={"Authorization": f"Basic {token}"}) as client:
        response = client.post("/v1/run-by-id", json=body)

    assert response.status_code == 400
    assert response.json() == {
        "error": {
            "code": "validation_failed",
            "message": "The workflow request is invalid.",
        }
    }
    assert contacted is False


def test_run_by_id_returns_safe_not_found_without_contacting_automation() -> None:
    contacted = False

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        nonlocal contacted
        contacted = True
        return httpx2.Response(500)

    client_iterator = authenticated_client(upstream, workflow=None)
    client, _ = next(client_iterator)
    client.app.state.workflow_service = StubWorkflowService(None)
    try:
        response = client.post("/v1/run-by-id", json={"workflowId": WORKFLOW_ID})
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert contacted is False


@pytest.mark.parametrize(
    ("status", "code", "message", "retry_after"),
    [
        pytest.param(422, "invalid_workflow", "Invalid workflow.", None, id="invalid-workflow"),
        pytest.param(429, "at_capacity", "At capacity.", "7", id="at-capacity"),
        pytest.param(500, "internal", "Automation failed.", None, id="internal"),
        pytest.param(503, "shutting_down", "Shutting down.", None, id="shutting-down"),
    ],
)
def test_run_by_id_passes_through_safe_upstream_rejections(
    status: int,
    code: str,
    message: str,
    retry_after: str | None,
) -> None:
    content = json.dumps({"error": {"code": code, "message": message}}).encode()

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        headers = {"Content-Type": "application/json"}
        if retry_after is not None:
            headers["Retry-After"] = retry_after
        return httpx2.Response(
            status,
            headers=headers,
            stream=byte_stream(content),
        )

    client_iterator = authenticated_client(upstream)
    client, _ = next(client_iterator)
    try:
        response = client.post("/v1/run-by-id", json={"workflowId": WORKFLOW_ID})
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == status
    assert response.content == content
    if retry_after is not None:
        assert response.headers["retry-after"] == retry_after
    else:
        assert "retry-after" not in response.headers


def test_run_by_id_omits_optional_fields_when_the_caller_omits_them() -> None:
    captured: dict = {}

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        captured.update(json.loads(request.content))
        return httpx2.Response(422, stream=byte_stream(b'{"error":{"code":"invalid"}}'))

    client_iterator = authenticated_client(upstream)
    client, _ = next(client_iterator)
    try:
        client.post("/v1/run-by-id", json={"workflowId": WORKFLOW_ID})
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert set(captured) == {"workflow"}


def test_run_by_id_returns_safe_unavailable_when_automation_cannot_be_reached() -> None:
    async def upstream(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("private upstream details", request=request)

    client_iterator = authenticated_client(upstream)
    client, _ = next(client_iterator)
    try:
        response = client.post("/v1/run-by-id", json={"workflowId": WORKFLOW_ID})
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "automation_unavailable",
            "message": "The automation service is unavailable.",
        }
    }


def test_artifact_route_proxies_webp_with_safe_headers() -> None:
    image = b"RIFF-private-webp"

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        assert request.method == "GET"
        assert str(request.url) == f"http://automation.internal:8080/v1/artifacts/{ARTIFACT_ID}"
        assert request.headers["accept"] == "image/webp"
        assert request.extensions["timeout"]["read"] == 30.0
        return httpx2.Response(
            200,
            headers={
                "Content-Type": "image/webp",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
            stream=byte_stream(image),
        )

    client_iterator = authenticated_client(upstream)
    client, _ = next(client_iterator)
    try:
        response = client.get(f"/v1/artifacts/{ARTIFACT_ID}", headers={"Accept": "image/webp"})
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 200
    assert response.content == image
    assert response.headers["content-type"] == "image/webp"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_artifact_route_requires_authentication_before_contacting_automation() -> None:
    contacted = False

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        nonlocal contacted
        contacted = True
        return httpx2.Response(500)

    automation_client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    app = create_app(
        settings=settings(),
        service=StubWorkflowService(complete_workflow()),
        automation_client=automation_client,
    )
    with TestClient(app) as client:
        response = client.get(f"/v1/artifacts/{ARTIFACT_ID}")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
    assert contacted is False


def test_artifact_route_passes_through_unknown_or_expired_response() -> None:
    content = b'{"error":{"code":"artifact_not_found","message":"Unknown or expired."}}'

    async def upstream(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            404,
            headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
            stream=byte_stream(content),
        )

    client_iterator = authenticated_client(upstream)
    client, _ = next(client_iterator)
    try:
        response = client.get(f"/v1/artifacts/{ARTIFACT_ID}")
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 404
    assert response.content == content
    assert response.headers["cache-control"] == "no-store"


def test_artifact_route_returns_safe_unavailable_when_automation_cannot_be_reached() -> None:
    async def upstream(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("private upstream details", request=request)

    client_iterator = authenticated_client(upstream)
    client, _ = next(client_iterator)
    try:
        response = client.get(f"/v1/artifacts/{ARTIFACT_ID}")
    finally:
        with pytest.raises(StopIteration):
            next(client_iterator)

    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "automation_unavailable",
            "message": "The automation service is unavailable.",
        }
    }


def test_run_by_id_disconnect_closes_an_unfinished_upstream_stream() -> None:
    class UnfinishedStream(httpx2.AsyncByteStream):
        def __init__(self) -> None:
            self.closed = False
            self.keep_open = asyncio.Event()

        async def __aiter__(self):
            yield b'{"runId":"run-1","type":"heartbeat"}\n'
            await self.keep_open.wait()

        async def aclose(self) -> None:
            self.closed = True

    stream = UnfinishedStream()

    async def exercise_disconnect() -> None:
        async def upstream(request: httpx2.Request) -> httpx2.Response:
            return httpx2.Response(
                200,
                headers={"Content-Type": "application/x-ndjson"},
                stream=stream,
            )

        automation_client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
        app = create_app(
            settings=settings(),
            service=StubWorkflowService(complete_workflow()),
            automation_client=automation_client,
        )
        token = base64.b64encode(b"relay:test-password").decode()
        request_body = json.dumps({"workflowId": WORKFLOW_ID}).encode()
        response_chunk_sent = asyncio.Event()
        request_body_sent = False
        messages: list[dict] = []

        async def receive() -> dict:
            nonlocal request_body_sent
            if not request_body_sent:
                request_body_sent = True
                return {"type": "http.request", "body": request_body, "more_body": False}
            await response_chunk_sent.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            messages.append(message)
            if message["type"] == "http.response.body" and message.get("body"):
                response_chunk_sent.set()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/v1/run-by-id",
            "raw_path": b"/v1/run-by-id",
            "query_string": b"",
            "root_path": "",
            "headers": [
                (b"authorization", f"Basic {token}".encode()),
                (b"content-type", b"application/json"),
                (b"content-length", str(len(request_body)).encode()),
                (b"accept", b"application/x-ndjson"),
            ],
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
            "state": {},
        }

        try:
            async with app.router.lifespan_context(app):
                await asyncio.wait_for(app(scope, receive, send), timeout=1)
                assert stream.closed is True
                assert any(
                    message.get("body") == b'{"runId":"run-1","type":"heartbeat"}\n'
                    for message in messages
                )
        finally:
            await automation_client.aclose()

    asyncio.run(exercise_disconnect())


def test_persistence_contract_defines_the_uuid_run_gateway() -> None:
    with open("openapi.yaml", encoding="utf-8") as contract_file:
        contract = yaml.safe_load(contract_file)

    run = contract["paths"]["/v1/run-by-id"]["post"]
    create_batch = contract["paths"]["/v1/batches"]["post"]
    get_batch = contract["paths"]["/v1/batches/{batchId}"]["get"]
    artifact = contract["paths"]["/v1/artifacts/{artifactId}"]["get"]

    assert run["operationId"] == "runWorkflowById"
    assert run["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/RunWorkflowByIdRequest"
    }
    assert "application/x-ndjson" in run["responses"]["200"]["content"]
    assert create_batch["operationId"] == "createBatch"
    assert create_batch["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/BatchRequest"
    }
    assert get_batch["operationId"] == "getBatch"
    assert create_batch["responses"]["202"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/BatchAccepted"
    }
    assert get_batch["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/BatchSnapshot"
    }
    assert artifact["operationId"] == "getRunArtifact"
    assert "image/webp" in artifact["responses"]["200"]["content"]
    assert "automation_unavailable" in contract["components"]["schemas"]["ErrorCode"]["enum"]

    schemas = contract["components"]["schemas"]
    assert schemas["BatchRequest"]["additionalProperties"] is False
    assert schemas["BatchRequest"]["properties"]["runs"]["minItems"] == 1
    assert schemas["BatchRequest"]["properties"]["runs"]["maxItems"] == 10
    assert schemas["BatchRunRequest"]["additionalProperties"] is False
    assert schemas["BatchRunRequest"]["properties"]["workflow"] == {
        "type": "object",
        "additionalProperties": True,
        "description": "Opaque executable workflow forwarded unchanged to the private service.",
    }


def test_unexpected_artifact_errors_do_not_log_the_artifact_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BrokenAutomationClient:
        def stream(self, *args, **kwargs):
            raise RuntimeError("broken test client")

    log_messages: list[str] = []

    def record_log(message: str, *args) -> None:
        log_messages.append(message % args)

    monkeypatch.setattr("relay_backend.main.logger.error", record_log)
    app = create_app(
        settings=settings(),
        service=StubWorkflowService(complete_workflow()),
        automation_client=BrokenAutomationClient(),
    )
    token = base64.b64encode(b"relay:test-password").decode()
    with TestClient(
        app,
        headers={"Authorization": f"Basic {token}"},
        raise_server_exceptions=False,
    ) as client:
        response = client.get(f"/v1/artifacts/{ARTIFACT_ID}")

    assert response.status_code == 500
    assert ARTIFACT_ID not in "".join(log_messages)
    assert log_messages == ["Unhandled RuntimeError during GET /v1/artifacts/{artifactId}"]


def test_unexpected_run_errors_do_not_log_workflow_or_parameter_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BrokenAutomationClient:
        def stream(self, *args, **kwargs):
            raise RuntimeError("broken test client")

    log_messages: list[str] = []

    def record_log(message: str, *args) -> None:
        log_messages.append(message % args)

    monkeypatch.setattr("relay_backend.main.logger.error", record_log)
    app = create_app(
        settings=settings(),
        service=StubWorkflowService(complete_workflow()),
        automation_client=BrokenAutomationClient(),
    )
    token = base64.b64encode(b"relay:test-password").decode()
    with TestClient(
        app,
        headers={"Authorization": f"Basic {token}"},
        raise_server_exceptions=False,
    ) as client:
        response = client.post(
            "/v1/run-by-id",
            json={
                "workflowId": WORKFLOW_ID,
                "parameterValues": {"secret-parameter": "private-value"},
            },
        )

    logged = "".join(log_messages)
    assert response.status_code == 500
    assert WORKFLOW_ID not in logged
    assert "secret-parameter" not in logged
    assert "private-value" not in logged
    assert log_messages == ["Unhandled RuntimeError during POST /v1/run-by-id"]


def test_production_server_disables_access_logging() -> None:
    start_command = Path("scripts/start-api.sh").read_text(encoding="utf-8")

    assert "--no-access-log" in start_command


def test_production_automation_client_uses_bounded_timeouts() -> None:
    app = create_app(settings=settings(), service=StubWorkflowService(complete_workflow()))

    with TestClient(app):
        timeout = app.state.automation_client.timeout
        assert timeout.connect == 5.0
        assert timeout.read == 30.0
        assert timeout.write == 30.0
        assert timeout.pool == 5.0
