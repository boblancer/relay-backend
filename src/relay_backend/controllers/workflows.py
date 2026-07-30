from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request

from relay_backend.auth import require_basic_auth
from relay_backend.errors import ValidationFailedError
from relay_backend.models.workflows import (
    SaveWorkflowRequest,
    Workflow,
    WorkflowListResponse,
)
from relay_backend.services.workflows import WorkflowService

router = APIRouter(
    prefix="/v1/workflows",
    dependencies=[Depends(require_basic_auth)],
)


def _service(request: Request) -> WorkflowService:
    return request.app.state.workflow_service


async def _require_empty_body(request: Request) -> None:
    if await request.body():
        raise ValidationFailedError


@router.get("", response_model=WorkflowListResponse)
def list_workflows(request: Request) -> WorkflowListResponse:
    return _service(request).list()


@router.post(
    "",
    dependencies=[Depends(_require_empty_body)],
    response_model=Workflow,
    response_model_exclude_none=True,
    status_code=201,
)
def create_workflow(
    request: Request,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
) -> Workflow:
    return _service(request).create(idempotency_key)


@router.get(
    "/{workflow_id}",
    response_model=Workflow,
    response_model_exclude_none=True,
)
def get_workflow(request: Request, workflow_id: UUID) -> Workflow:
    return _service(request).get(workflow_id)


@router.put(
    "/{workflow_id}",
    response_model=Workflow,
    response_model_exclude_none=True,
)
def save_workflow(
    request: Request,
    workflow_id: UUID,
    body: SaveWorkflowRequest,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
) -> Workflow:
    return _service(request).save(workflow_id, body, idempotency_key)


@router.post(
    "/{workflow_id}/finish",
    response_model=Workflow,
    response_model_exclude_none=True,
)
def finish_workflow(
    request: Request,
    workflow_id: UUID,
    body: SaveWorkflowRequest,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
) -> Workflow:
    return _service(request).finish(workflow_id, body, idempotency_key)
