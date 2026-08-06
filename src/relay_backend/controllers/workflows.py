from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, UploadFile
from fastapi.responses import Response

from relay_backend.auth import require_basic_auth
from relay_backend.errors import BlobNotFoundError, ValidationFailedError
from relay_backend.models.workflows import (
    SaveWorkflowRequest,
    Workflow,
    WorkflowListResponse,
)
from relay_backend.services.workflows import WorkflowService

router = APIRouter(
    prefix="/v1/namespaces/{namespace_id}/workflows",
    dependencies=[Depends(require_basic_auth)],
)


def _service(request: Request) -> WorkflowService:
    return request.app.state.workflow_service


async def _require_empty_body(request: Request) -> None:
    if await request.body():
        raise ValidationFailedError


@router.get("", response_model=WorkflowListResponse)
def list_workflows(request: Request, namespace_id: int) -> WorkflowListResponse:
    return _service(request).list(namespace_id)


@router.post(
    "",
    dependencies=[Depends(_require_empty_body)],
    response_model=Workflow,
    response_model_exclude_none=True,
    status_code=201,
)
def create_workflow(
    request: Request,
    namespace_id: int,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
) -> Workflow:
    return _service(request).create(namespace_id, idempotency_key)


@router.get(
    "/{workflow_id}",
    response_model=Workflow,
    response_model_exclude_none=True,
)
def get_workflow(request: Request, namespace_id: int, workflow_id: UUID) -> Workflow:
    del namespace_id
    return _service(request).get(workflow_id)


@router.put(
    "/{workflow_id}",
    response_model=Workflow,
    response_model_exclude_none=True,
)
def save_workflow(
    request: Request,
    namespace_id: int,
    workflow_id: UUID,
    body: SaveWorkflowRequest,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
) -> Workflow:
    return _service(request).save(namespace_id, workflow_id, body, idempotency_key)


@router.post(
    "/{workflow_id}/finish",
    response_model=Workflow,
    response_model_exclude_none=True,
)
def finish_workflow(
    request: Request,
    namespace_id: int,
    workflow_id: UUID,
    body: SaveWorkflowRequest,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
) -> Workflow:
    return _service(request).finish(namespace_id, workflow_id, body, idempotency_key)


@router.post("/{workflow_id}/upload")
async def upload_file(
    request: Request, namespace_id: int, workflow_id: UUID, file: UploadFile
) -> dict:
    data = await file.read()
    file_url = _service(request).upload_file(
        namespace_id, workflow_id, file.filename or "upload", data
    )
    return {"fileUrl": file_url}


@router.get("/{workflow_id}/download")
def download_file(
    request: Request, namespace_id: int, workflow_id: UUID
) -> Response:
    with _service(request)._transaction() as connection:
        row = connection.execute(
            "SELECT file_url FROM workflows WHERE id = %s", (workflow_id,)
        ).fetchone()
    if row is None or row["file_url"] is None:
        raise BlobNotFoundError
    file_url = row["file_url"]
    filename = file_url.rsplit("/", 1)[-1]
    data = _service(request).download_file(namespace_id, workflow_id, filename)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
