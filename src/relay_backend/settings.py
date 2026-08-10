from __future__ import annotations

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    basic_auth_username: str = Field(min_length=1)
    basic_auth_password: SecretStr = Field(min_length=1)
