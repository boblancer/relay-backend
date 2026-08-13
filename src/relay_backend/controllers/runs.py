from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager
from typing import Any
from uuid import UUID

import httpx2
from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

from relay_backend.auth import require_basic_auth
from relay_backend.errors import AutomationUnavailableError
from relay_backend.models.workflows import CreateBatchRequest, RunWorkflowByIdRequest, Workflow
from relay_backend.request_limits import MAX_REQUEST_BYTES
from relay_backend.services.workflows import WorkflowService

router = APIRouter(
    prefix="/v1",
    dependencies=[Depends(require_basic_auth)],
)

_PASSTHROUGH_RESPONSE_HEADERS = {
    "cache-control",
    "content-type",
    "retry-after",
    "x-accel-buffering",
    "x-content-type-options",
    "x-run-id",
}
_BATCH_RESPONSE_HEADERS = {
    "cache-control",
    "content-type",
    "retry-after",
    "x-content-type-options",
}
_ARTIFACT_TIMEOUT = httpx2.Timeout(connect=5.0, read=30.0, write=30.0, pool=5.0)


def _workflow_service(request: Request) -> WorkflowService:
    return request.app.state.workflow_service


def _automation_client(request: Request) -> httpx2.AsyncClient:
    return request.app.state.automation_client


def _upstream_url(request: Request, path: str) -> str:
    base_url = str(request.app.state.settings.automation_service_url).rstrip("/")
    return f"{base_url}{path}"


def _response_headers(
    response: httpx2.Response,
    allowed_headers: set[str] = _PASSTHROUGH_RESPONSE_HEADERS,
) -> dict[str, str]:
    return {
        name: value for name, value in response.headers.items() if name.lower() in allowed_headers
    }


async def _open_upstream(
    stream_context: AbstractAsyncContextManager[httpx2.Response],
) -> httpx2.Response:
    try:
        return await stream_context.__aenter__()
    except httpx2.RequestError:
        raise AutomationUnavailableError from None


def _streaming_response(
    response: httpx2.Response,
    stream_context: AbstractAsyncContextManager[httpx2.Response],
) -> StreamingResponse:
    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in response.aiter_raw():
                yield chunk
        finally:
            await stream_context.__aexit__(None, None, None)

    return StreamingResponse(
        body(),
        status_code=response.status_code,
        headers=_response_headers(response),
    )


async def _bounded_batch_response(
    stream_context: AbstractAsyncContextManager[httpx2.Response],
) -> Response:
    response = await _open_upstream(stream_context)
    body = bytearray()
    try:
        try:
            async for chunk in response.aiter_raw():
                if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                    raise AutomationUnavailableError
                body.extend(chunk)
        except httpx2.RequestError:
            raise AutomationUnavailableError from None
    finally:
        try:
            await stream_context.__aexit__(None, None, None)
        except httpx2.RequestError:
            raise AutomationUnavailableError from None

    return Response(
        content=bytes(body),
        status_code=response.status_code,
        headers=_response_headers(response, _BATCH_RESPONSE_HEADERS),
    )


@router.post("/run-by-id")
async def run_workflow_by_id(
    request: Request,
    body: RunWorkflowByIdRequest,
) -> StreamingResponse:
    workflow: Workflow = await run_in_threadpool(
        _workflow_service(request).get,
        body.workflow_id,
    )
    upstream_body: dict[str, Any] = {
        "workflow": workflow.model_dump(mode="json", by_alias=True, exclude_none=True),
    }
    if body.start_step_id is not None:
        upstream_body["startStepId"] = body.start_step_id
    if body.parameter_values is not None:
        upstream_body["parameterValues"] = body.parameter_values

    headers = {"Content-Type": "application/json"}
    if accept := request.headers.get("accept"):
        headers["Accept"] = accept
    stream_context = _automation_client(request).stream(
        "POST",
        _upstream_url(request, "/v1/run"),
        headers=headers,
        json=upstream_body,
    )
    response = await _open_upstream(stream_context)
    return _streaming_response(response, stream_context)


@router.post("/batches")
async def create_batch(request: Request, body: CreateBatchRequest) -> Response:
    headers = {"Content-Type": "application/json"}
    if accept := request.headers.get("accept"):
        headers["Accept"] = accept
    stream_context = _automation_client(request).stream(
        "POST",
        _upstream_url(request, "/v1/batches"),
        headers=headers,
        json=body.model_dump(mode="json", by_alias=True),
    )
    return await _bounded_batch_response(stream_context)


@router.get("/batches/{batch_id}")
async def get_batch(request: Request, batch_id: UUID) -> Response:
    headers: dict[str, str] = {}
    if accept := request.headers.get("accept"):
        headers["Accept"] = accept
    stream_context = _automation_client(request).stream(
        "GET",
        _upstream_url(request, f"/v1/batches/{batch_id}"),
        headers=headers,
    )
    return await _bounded_batch_response(stream_context)


@router.get("/artifacts/{artifact_id}")
async def get_run_artifact(request: Request, artifact_id: UUID) -> StreamingResponse:
    headers: dict[str, str] = {}
    if accept := request.headers.get("accept"):
        headers["Accept"] = accept
    stream_context = _automation_client(request).stream(
        "GET",
        _upstream_url(request, f"/v1/artifacts/{artifact_id}"),
        headers=headers,
        timeout=_ARTIFACT_TIMEOUT,
    )
    response = await _open_upstream(stream_context)
    return _streaming_response(response, stream_context)
