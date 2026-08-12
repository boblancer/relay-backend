from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg import Connection
from psycopg.types.json import Jsonb

from relay_backend.errors import IdempotencyConflictError, InternalPersistenceError


@dataclass(frozen=True)
class IdempotencyReplay:
    status: int
    body: dict[str, Any]


class IdempotencyRepository:
    def claim(
        self,
        connection: Connection,
        *,
        key: UUID,
        method: str,
        path: str,
        request_hash: bytes,
    ) -> IdempotencyReplay | None:
        claimed = connection.execute(
            """
            INSERT INTO idempotency_records (key, method, path, request_hash)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (key) DO NOTHING
            RETURNING key
            """,
            (key, method, path, request_hash),
        ).fetchone()
        if claimed is not None:
            return None
        existing = connection.execute(
            """
            SELECT method, path, request_hash, response_status, response_body
              FROM idempotency_records
             WHERE key = %s
            """,
            (key,),
        ).fetchone()
        if existing is None:
            raise InternalPersistenceError
        if (
            existing["method"] != method
            or existing["path"] != path
            or bytes(existing["request_hash"]) != request_hash
        ):
            raise IdempotencyConflictError
        if existing["response_status"] is None or existing["response_body"] is None:
            raise InternalPersistenceError
        return IdempotencyReplay(existing["response_status"], existing["response_body"])

    def complete(
        self,
        connection: Connection,
        *,
        key: UUID,
        status: int,
        body: dict[str, Any],
    ) -> None:
        cursor = connection.execute(
            """
            UPDATE idempotency_records
               SET response_status = %s, response_body = %s
             WHERE key = %s AND response_status IS NULL
            """,
            (status, Jsonb(body), key),
        )
        if cursor.rowcount != 1:
            raise InternalPersistenceError
