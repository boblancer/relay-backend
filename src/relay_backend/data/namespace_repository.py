from __future__ import annotations

from psycopg import Connection

from relay_backend.errors import NamespaceNotFoundError
from relay_backend.models.namespaces import Namespace


class NamespaceRepository:
    def list_namespaces(self, connection: Connection) -> list[Namespace]:
        rows = connection.execute(
            "SELECT id, name, created_at, updated_at FROM namespaces ORDER BY created_at DESC"
        ).fetchall()
        return [Namespace.model_validate(row) for row in rows]

    def get_namespace(self, connection: Connection, namespace_id: int) -> Namespace:
        row = connection.execute(
            "SELECT id, name, created_at, updated_at FROM namespaces WHERE id = %s",
            (namespace_id,),
        ).fetchone()
        if row is None:
            raise NamespaceNotFoundError
        return Namespace.model_validate(row)

    def create_namespace(self, connection: Connection, name: str) -> int:
        row = connection.execute(
            "INSERT INTO namespaces (name) VALUES (%s) RETURNING id",
            (name,),
        ).fetchone()
        assert row is not None
        return row["id"]
