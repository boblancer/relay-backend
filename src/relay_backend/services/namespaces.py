from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg import Connection
from psycopg_pool import PoolTimeout

from relay_backend.data.database import Database
from relay_backend.data.namespace_repository import NamespaceRepository
from relay_backend.errors import (
    BlobNotFoundError,
    DuplicateNameError,
    InternalPersistenceError,
    PersistenceUnavailableError,
    WorkflowError,
)
from relay_backend.models.namespaces import Namespace, Record
from relay_backend.storage import BlobStorage


class NamespaceService:
    def __init__(
        self,
        database: Database,
        storage: BlobStorage,
        *,
        repository: NamespaceRepository | None = None,
    ) -> None:
        self.database = database
        self.storage = storage
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

    def list_records(self, namespace_id: int) -> list[Record]:
        with self._transaction() as connection:
            return self.repository.list_records(connection, namespace_id)

    def create_record(self, namespace_id: int, name: str) -> Record:
        try:
            with self._transaction() as connection:
                record_id = self.repository.create_record(connection, namespace_id, name)
                return self.repository.get_record(connection, record_id)
        except psycopg.errors.UniqueViolation as error:
            raise DuplicateNameError from error

    def get_record(self, record_id: int) -> Record:
        with self._transaction() as connection:
            return self.repository.get_record(connection, record_id)

    def upload_file(
        self, namespace_id: int, record_id: int, filename: str, data: bytes
    ) -> Record:
        file_url = self.storage.save(namespace_id, record_id, filename, data)
        with self._transaction() as connection:
            self.repository.update_record_file_url(connection, record_id, file_url)
            return self.repository.get_record(connection, record_id)

    def download_file(
        self, namespace_id: int, record_id: int, filename: str
    ) -> bytes:
        try:
            return self.storage.read(namespace_id, record_id, filename)
        except FileNotFoundError as error:
            raise BlobNotFoundError from error

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
