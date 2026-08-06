from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import UUID, uuid4

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
        uuid_factory: Callable[[], UUID] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.database = database
        self.storage = storage
        self.repository = repository or NamespaceRepository()
        self.uuid_factory = uuid_factory or uuid4
        self.clock = clock or (lambda: datetime.now(UTC))

    def list_namespaces(self) -> list[Namespace]:
        with self._transaction() as connection:
            return self.repository.list_namespaces(connection)

    def create_namespace(self, name: str) -> Namespace:
        now = self.clock()
        namespace = Namespace(
            id=self.uuid_factory(),
            name=name,
            created_at=now,
            updated_at=now,
        )
        try:
            with self._transaction() as connection:
                self.repository.create_namespace(connection, namespace)
        except psycopg.errors.UniqueViolation as error:
            raise DuplicateNameError from error
        return namespace

    def get_namespace(self, namespace_id: UUID) -> Namespace:
        with self._transaction() as connection:
            return self.repository.get_namespace(connection, namespace_id)

    def list_records(self, namespace_id: UUID) -> list[Record]:
        with self._transaction() as connection:
            return self.repository.list_records(connection, namespace_id)

    def create_record(self, namespace_id: UUID, name: str) -> Record:
        now = self.clock()
        record = Record(
            id=self.uuid_factory(),
            namespace_id=namespace_id,
            name=name,
            created_at=now,
            updated_at=now,
        )
        try:
            with self._transaction() as connection:
                self.repository.create_record(connection, record)
        except psycopg.errors.UniqueViolation as error:
            raise DuplicateNameError from error
        return record

    def get_record(self, record_id: UUID) -> Record:
        with self._transaction() as connection:
            return self.repository.get_record(connection, record_id)

    def upload_file(
        self, namespace_id: UUID, record_id: UUID, filename: str, data: bytes
    ) -> Record:
        file_url = self.storage.save(namespace_id, record_id, filename, data)
        with self._transaction() as connection:
            self.repository.update_record_file_url(connection, record_id, file_url)
            return self.repository.get_record(connection, record_id)

    def download_file(
        self, namespace_id: UUID, record_id: UUID, filename: str
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
        except psycopg.Error as error:
            raise InternalPersistenceError from error
