from __future__ import annotations

from pydantic import AnyHttpUrl, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        hide_input_in_errors=True,
    )

    database_url: str
    basic_auth_username: str = Field(min_length=1)
    basic_auth_password: SecretStr = Field(min_length=1)
    bucket: str = Field(min_length=1)
    endpoint: str = Field(min_length=1)
    access_key_id: SecretStr = Field(min_length=1)
    secret_access_key: SecretStr = Field(min_length=1)
    region: str = Field(min_length=1)
    automation_service_url: AnyHttpUrl = AnyHttpUrl("http://127.0.0.1:8080")
