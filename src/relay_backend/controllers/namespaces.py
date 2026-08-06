from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Request, UploadFile
from fastapi.responses import Response

from relay_backend.auth import require_basic_auth
from relay_backend.models.namespaces import (
    CreateNamespaceRequest,
    CreateRecordRequest,
    Namespace,
    Record,
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
def get_namespace(request: Request, namespace_id: UUID) -> Namespace:
    return _service(request).get_namespace(namespace_id)


@router.get("/{namespace_id}/records", response_model=list[Record])
def list_records(request: Request, namespace_id: UUID) -> list[Record]:
    return _service(request).list_records(namespace_id)


@router.post(
    "/{namespace_id}/records",
    response_model=Record,
    response_model_exclude_none=True,
    status_code=201,
)
def create_record(
    request: Request, namespace_id: UUID, body: CreateRecordRequest
) -> Record:
    return _service(request).create_record(namespace_id, body.name)


@router.get(
    "/{namespace_id}/records/{record_id}",
    response_model=Record,
    response_model_exclude_none=True,
)
def get_record(request: Request, namespace_id: UUID, record_id: UUID) -> Record:
    del namespace_id
    return _service(request).get_record(record_id)


@router.post("/{namespace_id}/records/{record_id}/upload", response_model=Record)
async def upload_file(
    request: Request, namespace_id: UUID, record_id: UUID, file: UploadFile
) -> Record:
    data = await file.read()
    return _service(request).upload_file(namespace_id, record_id, file.filename or "upload", data)


@router.get("/{namespace_id}/records/{record_id}/download")
def download_file(
    request: Request, namespace_id: UUID, record_id: UUID
) -> Response:
    record = _service(request).get_record(record_id)
    if record.file_url is None:
        from relay_backend.errors import BlobNotFoundError

        raise BlobNotFoundError
    filename = record.file_url.rsplit("/", 1)[-1]
    data = _service(request).download_file(namespace_id, record_id, filename)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
