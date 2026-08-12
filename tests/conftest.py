from __future__ import annotations

import os
from collections.abc import Iterator
from unittest.mock import patch

import psycopg
import pytest
from alembic import command
from alembic.config import Config

DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql://relay:relay@localhost:5432/relay",
)


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> Iterator[None]:
    config = Config("alembic.ini")
    config.set_main_option(
        "sqlalchemy.url",
        DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1),
    )
    with patch.dict(os.environ, {"DATABASE_URL": DATABASE_URL}):
        command.upgrade(config, "head")
    yield


@pytest.fixture(autouse=True)
def clean_database(migrated_database: None) -> Iterator[None]:
    del migrated_database
    with psycopg.connect(DATABASE_URL) as connection:
        connection.execute("TRUNCATE idempotency_records, workflows")
        connection.execute("DELETE FROM namespaces WHERE name <> 'Default'")
    yield
