from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request

from relay_backend.auth import require_basic_auth
from relay_backend.errors import ValidationFailedError
from relay_backend.models.namespaces import CreateNamespaceRequest, Namespace, NamespaceListResponse
from relay_backend.models.workflows import SaveWorkflowRequest, Workflow, WorkflowListResponse
from relay_backend.services.namespaces import NamespaceService
from relay_backend.services.workflows import WorkflowService

router = APIRouter(
    prefix="/v1/namespaces",
    dependencies=[Depends(require_basic_auth)],
)


def _namespace_service(request: Request) -> NamespaceService:
    return request.app.state.namespace_service


def _workflow_service(request: Request) -> WorkflowService:
    return request.app.state.workflow_service


async def _require_empty_body(request: Request) -> None:
    if await request.body():
        raise ValidationFailedError


@router.get("", response_model=NamespaceListResponse)
def list_namespaces(request: Request) -> NamespaceListResponse:
    return _namespace_service(request).list()


@router.post("", response_model=Namespace, status_code=201)
def create_namespace(
    request: Request,
    body: CreateNamespaceRequest,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
) -> Namespace:
    return _namespace_service(request).create(body, idempotency_key)


@router.get("/{namespace_id}", response_model=Namespace)
def get_namespace(request: Request, namespace_id: UUID) -> Namespace:
    return _namespace_service(request).get(namespace_id)


@router.get("/{namespace_id}/workflows", response_model=WorkflowListResponse)
def list_workflows(request: Request, namespace_id: UUID) -> WorkflowListResponse:
    return _workflow_service(request).list_scoped(namespace_id)


@router.post(
    "/{namespace_id}/workflows",
    dependencies=[Depends(_require_empty_body)],
    response_model=Workflow,
    response_model_exclude_none=True,
    status_code=201,
)
def create_workflow(
    request: Request,
    namespace_id: UUID,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
) -> Workflow:
    return _workflow_service(request).create_scoped(namespace_id, idempotency_key)


@router.get(
    "/{namespace_id}/workflows/{workflow_id}",
    response_model=Workflow,
    response_model_exclude_none=True,
)
def get_workflow(request: Request, namespace_id: UUID, workflow_id: UUID) -> Workflow:
    return _workflow_service(request).get_scoped(namespace_id, workflow_id)


@router.put(
    "/{namespace_id}/workflows/{workflow_id}",
    response_model=Workflow,
    response_model_exclude_none=True,
)
def save_workflow(
    request: Request,
    namespace_id: UUID,
    workflow_id: UUID,
    body: SaveWorkflowRequest,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
) -> Workflow:
    return _workflow_service(request).save_scoped(namespace_id, workflow_id, body, idempotency_key)


@router.post(
    "/{namespace_id}/workflows/{workflow_id}/finish",
    response_model=Workflow,
    response_model_exclude_none=True,
)
def finish_workflow(
    request: Request,
    namespace_id: UUID,
    workflow_id: UUID,
    body: SaveWorkflowRequest,
    idempotency_key: Annotated[UUID, Header(alias="Idempotency-Key")],
) -> Workflow:
    return _workflow_service(request).finish_scoped(
        namespace_id, workflow_id, body, idempotency_key
    )
