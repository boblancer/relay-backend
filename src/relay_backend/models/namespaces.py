from __future__ import annotations

from datetime import datetime

from pydantic import Field

from relay_backend.models.workflows import ApiModel


class Namespace(ApiModel):
    id: int
    name: str = Field(min_length=1)
    created_at: datetime
    updated_at: datetime


class Record(ApiModel):
    id: int
    namespace_id: int
    name: str = Field(min_length=1)
    file_url: str | None = None
    created_at: datetime
    updated_at: datetime


class CreateNamespaceRequest(ApiModel):
    name: str = Field(min_length=1)


class CreateRecordRequest(ApiModel):
    name: str = Field(min_length=1)
