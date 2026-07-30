from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


class Database:
    def __init__(
        self,
        database_url: str,
        *,
        min_size: int = 1,
        max_size: int = 10,
    ) -> None:
        self.pool = ConnectionPool(
            conninfo=database_url,
            min_size=min_size,
            max_size=max_size,
            open=False,
            kwargs={"row_factory": dict_row},
        )

    def open(self) -> None:
        self.pool.open(wait=True)

    def close(self) -> None:
        self.pool.close()

    @contextmanager
    def transaction(self) -> Iterator[Connection]:
        with self.pool.connection() as connection, connection.transaction():
            yield connection
