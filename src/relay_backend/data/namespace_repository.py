from __future__ import annotations

from datetime import datetime
from uuid import UUID

from psycopg import Connection

from relay_backend.errors import NamespaceNotFoundError, ScopedWorkflowNotFoundError
from relay_backend.models.namespaces import Namespace

DEFAULT_NAMESPACE_NAME = "Default"


class NamespaceRepository:
    def list(self, connection: Connection) -> list[Namespace]:
        rows = connection.execute(
            "SELECT id, name, created_at, updated_at FROM namespaces ORDER BY name, id"
        ).fetchall()
        return [Namespace.model_validate(row) for row in rows]

    def get(self, connection: Connection, namespace_id: UUID) -> Namespace:
        row = connection.execute(
            "SELECT id, name, created_at, updated_at FROM namespaces WHERE id = %s",
            (namespace_id,),
        ).fetchone()
        if row is None:
            raise NamespaceNotFoundError
        return Namespace.model_validate(row)

    def require_scope(self, connection: Connection, namespace_id: UUID) -> None:
        row = connection.execute(
            "SELECT 1 FROM namespaces WHERE id = %s",
            (namespace_id,),
        ).fetchone()
        if row is None:
            raise ScopedWorkflowNotFoundError

    def get_or_create_default(self, connection: Connection, namespace_id: UUID) -> UUID:
        row = connection.execute(
            "SELECT id FROM namespaces WHERE name = %s",
            (DEFAULT_NAMESPACE_NAME,),
        ).fetchone()
        if row is not None:
            return row["id"]
        row = connection.execute(
            """
            INSERT INTO namespaces (id, name)
            VALUES (%s, %s)
            ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
            """,
            (namespace_id, DEFAULT_NAMESPACE_NAME),
        ).fetchone()
        return row["id"]

    def insert(
        self,
        connection: Connection,
        *,
        namespace_id: UUID,
        name: str,
        now: datetime,
    ) -> Namespace:
        row = connection.execute(
            """
            INSERT INTO namespaces (id, name, created_at, updated_at)
            VALUES (%s, %s, %s, %s)
            RETURNING id, name, created_at, updated_at
            """,
            (namespace_id, name, now, now),
        ).fetchone()
        return Namespace.model_validate(row)
