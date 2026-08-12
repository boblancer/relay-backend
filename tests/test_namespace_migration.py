from __future__ import annotations

import os
from unittest.mock import patch
from uuid import uuid4

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from psycopg.types.json import Jsonb

from tests.conftest import DATABASE_URL
from tests.test_models import workflow_document


def _config() -> Config:
    config = Config("alembic.ini")
    config.set_main_option(
        "sqlalchemy.url",
        DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1),
    )
    return config


def test_migration_backfills_default_without_changing_workflow_values() -> None:
    config = _config()
    workflow = workflow_document()
    workflow_id = uuid4()
    workflow["id"] = str(workflow_id)
    summary = {
        "id": str(workflow_id),
        "name": "Checkout flow",
        "status": "draft",
        "updatedAt": workflow["updatedAt"],
        "steps": [],
    }

    with patch.dict(os.environ, {"DATABASE_URL": DATABASE_URL}):
        command.downgrade(config, "0003")
        try:
            with psycopg.connect(DATABASE_URL) as connection:
                connection.execute("DELETE FROM idempotency_records")
                connection.execute("DELETE FROM workflows")
                connection.execute(
                    """
                    INSERT INTO workflows (
                        id, revision, status, created_at, updated_at, finished_at,
                        document, document_key, summary
                    ) VALUES (%s, 1, 'draft', %s, %s, NULL, %s, NULL, %s)
                    """,
                    (
                        workflow_id,
                        workflow["createdAt"],
                        workflow["updatedAt"],
                        Jsonb(workflow),
                        Jsonb(summary),
                    ),
                )
                before = connection.execute(
                    "SELECT * FROM workflows WHERE id = %s", (workflow_id,)
                ).fetchone()

            command.upgrade(config, "0004")

            with psycopg.connect(DATABASE_URL) as connection:
                after = connection.execute(
                    "SELECT * FROM workflows WHERE id = %s", (workflow_id,)
                ).fetchone()
                default_id = connection.execute(
                    "SELECT id FROM namespaces WHERE name = 'Default'"
                ).fetchone()[0]
            assert after[-1] == default_id
            assert after[:-1] == before

            command.downgrade(config, "0003")
            with psycopg.connect(DATABASE_URL) as connection:
                columns = {
                    row[0]
                    for row in connection.execute(
                        """
                        SELECT column_name FROM information_schema.columns
                         WHERE table_name = 'workflows'
                        """
                    )
                }
            assert "namespace_id" not in columns
        finally:
            command.upgrade(config, "head")


def test_migration_refuses_invalid_existing_namespace_names() -> None:
    config = _config()
    invalid_id = uuid4()
    with patch.dict(os.environ, {"DATABASE_URL": DATABASE_URL}):
        command.downgrade(config, "0003")
        try:
            with psycopg.connect(DATABASE_URL) as connection:
                connection.execute(
                    "INSERT INTO namespaces (id, name) VALUES (%s, %s)",
                    (invalid_id, " Untrimmed "),
                )
            with pytest.raises(
                RuntimeError,
                match="namespace names violate the public contract",
            ):
                command.upgrade(config, "0004")
        finally:
            with psycopg.connect(DATABASE_URL) as connection:
                connection.execute("DELETE FROM namespaces WHERE id = %s", (invalid_id,))
            command.upgrade(config, "head")
