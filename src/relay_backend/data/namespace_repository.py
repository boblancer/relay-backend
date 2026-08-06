from __future__ import annotations

from uuid import UUID

from psycopg import Connection

from relay_backend.errors import NamespaceNotFoundError, RecordNotFoundError
from relay_backend.models.namespaces import Namespace, Record


class NamespaceRepository:
    def list_namespaces(self, connection: Connection) -> list[Namespace]:
        rows = connection.execute(
            "SELECT id, name, created_at, updated_at FROM namespaces ORDER BY created_at DESC"
        ).fetchall()
        return [Namespace.model_validate(row) for row in rows]

    def get_namespace(self, connection: Connection, namespace_id: UUID) -> Namespace:
        row = connection.execute(
            "SELECT id, name, created_at, updated_at FROM namespaces WHERE id = %s",
            (namespace_id,),
        ).fetchone()
        if row is None:
            raise NamespaceNotFoundError
        return Namespace.model_validate(row)

    def create_namespace(self, connection: Connection, namespace: Namespace) -> None:
        connection.execute(
            """
            INSERT INTO namespaces (id, name, created_at, updated_at)
            VALUES (%s, %s, %s, %s)
            """,
            (namespace.id, namespace.name, namespace.created_at, namespace.updated_at),
        )

    def list_records(self, connection: Connection, namespace_id: UUID) -> list[Record]:
        rows = connection.execute(
            """
            SELECT id, namespace_id, name, file_url, created_at, updated_at
            FROM records
            WHERE namespace_id = %s
            ORDER BY created_at DESC
            """,
            (namespace_id,),
        ).fetchall()
        return [Record.model_validate(row) for row in rows]

    def get_record(self, connection: Connection, record_id: UUID) -> Record:
        row = connection.execute(
            """
            SELECT id, namespace_id, name, file_url, created_at, updated_at
            FROM records
            WHERE id = %s
            """,
            (record_id,),
        ).fetchone()
        if row is None:
            raise RecordNotFoundError
        return Record.model_validate(row)

    def create_record(self, connection: Connection, record: Record) -> None:
        connection.execute(
            """
            INSERT INTO records (id, namespace_id, name, file_url, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (
                record.id,
                record.namespace_id,
                record.name,
                record.file_url,
                record.created_at,
                record.updated_at,
            ),
        )

    def update_record_file_url(
        self, connection: Connection, record_id: UUID, file_url: str
    ) -> None:
        cursor = connection.execute(
            "UPDATE records SET file_url = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
            (file_url, record_id),
        )
        if cursor.rowcount != 1:
            raise RecordNotFoundError
