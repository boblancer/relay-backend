from __future__ import annotations

from uuid import UUID

from pydantic import AwareDatetime, Field, field_validator

from relay_backend.models.workflows import ApiModel


class CreateNamespaceRequest(ApiModel):
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class Namespace(ApiModel):
    id: UUID
    name: str = Field(min_length=1, max_length=100)
    created_at: AwareDatetime
    updated_at: AwareDatetime


class NamespaceListResponse(ApiModel):
    namespaces: list[Namespace]
