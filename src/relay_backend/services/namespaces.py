from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg import Connection
from psycopg_pool import PoolTimeout

from relay_backend.data.database import Database
from relay_backend.data.namespace_repository import NamespaceRepository
from relay_backend.errors import (
    DuplicateNameError,
    InternalPersistenceError,
    PersistenceUnavailableError,
    WorkflowError,
)
from relay_backend.models.namespaces import Namespace


class NamespaceService:
    def __init__(
        self,
        database: Database,
        *,
        repository: NamespaceRepository | None = None,
    ) -> None:
        self.database = database
        self.repository = repository or NamespaceRepository()

    def list_namespaces(self) -> list[Namespace]:
        with self._transaction() as connection:
            return self.repository.list_namespaces(connection)

    def create_namespace(self, name: str) -> Namespace:
        try:
            with self._transaction() as connection:
                namespace_id = self.repository.create_namespace(connection, name)
                return self.repository.get_namespace(connection, namespace_id)
        except psycopg.errors.UniqueViolation as error:
            raise DuplicateNameError from error

    def get_namespace(self, namespace_id: int) -> Namespace:
        with self._transaction() as connection:
            return self.repository.get_namespace(connection, namespace_id)

    @contextmanager
    def _transaction(self) -> Iterator[Connection]:
        try:
            with self.database.transaction() as connection:
                yield connection
        except WorkflowError:
            raise
        except (psycopg.OperationalError, PoolTimeout) as error:
            raise PersistenceUnavailableError from error
        except psycopg.errors.UniqueViolation:
            raise
        except psycopg.Error as error:
            raise InternalPersistenceError from error
