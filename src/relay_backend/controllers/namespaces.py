from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from relay_backend.auth import require_basic_auth
from relay_backend.models.namespaces import (
    CreateNamespaceRequest,
    Namespace,
)
from relay_backend.services.namespaces import NamespaceService

router = APIRouter(
    prefix="/v1/namespaces",
    dependencies=[Depends(require_basic_auth)],
)


def _service(request: Request) -> NamespaceService:
    return request.app.state.namespace_service


@router.get("", response_model=list[Namespace])
def list_namespaces(request: Request) -> list[Namespace]:
    return _service(request).list_namespaces()


@router.post(
    "",
    response_model=Namespace,
    response_model_exclude_none=True,
    status_code=201,
)
def create_namespace(request: Request, body: CreateNamespaceRequest) -> Namespace:
    return _service(request).create_namespace(body.name)


@router.get(
    "/{namespace_id}",
    response_model=Namespace,
    response_model_exclude_none=True,
)
def get_namespace(request: Request, namespace_id: int) -> Namespace:
    return _service(request).get_namespace(namespace_id)
