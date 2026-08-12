from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg import Connection
from psycopg.errors import UniqueViolation
from psycopg_pool import PoolTimeout

from relay_backend.data.database import Database
from relay_backend.data.idempotency_repository import IdempotencyRepository
from relay_backend.data.namespace_repository import NamespaceRepository
from relay_backend.errors import (
    InternalPersistenceError,
    NamespaceConflictError,
    PersistenceUnavailableError,
    WorkflowError,
)
from relay_backend.models.namespaces import CreateNamespaceRequest, Namespace, NamespaceListResponse
from relay_backend.models.workflows import canonical_request_hash


class NamespaceService:
    def __init__(
        self,
        database: Database,
        *,
        repository: NamespaceRepository | None = None,
        idempotency_repository: IdempotencyRepository | None = None,
        clock: Callable[[], datetime] | None = None,
        uuid_factory: Callable[[], UUID] | None = None,
    ) -> None:
        self.database = database
        self.repository = repository or NamespaceRepository()
        self.idempotency_repository = idempotency_repository or IdempotencyRepository()
        self.clock = clock or (lambda: datetime.now(UTC))
        self.uuid_factory = uuid_factory or uuid4

    def list(self) -> NamespaceListResponse:
        with self._transaction() as connection:
            return NamespaceListResponse(namespaces=self.repository.list(connection))

    def get(self, namespace_id: UUID) -> Namespace:
        with self._transaction() as connection:
            return self.repository.get(connection, namespace_id)

    def create(self, request: CreateNamespaceRequest, idempotency_key: UUID) -> Namespace:
        request = CreateNamespaceRequest.model_validate(request.model_dump(mode="python"))
        method = "POST"
        path = "/v1/namespaces"
        with self._transaction() as connection:
            replay = self.idempotency_repository.claim(
                connection,
                key=idempotency_key,
                method=method,
                path=path,
                request_hash=canonical_request_hash(method, path, request),
            )
            if replay is not None:
                return Namespace.model_validate(replay.body)
            namespace = self.repository.insert(
                connection,
                namespace_id=self.uuid_factory(),
                name=request.name,
                now=self.clock(),
            )
            self.idempotency_repository.complete(
                connection,
                key=idempotency_key,
                status=201,
                body=_namespace_json(namespace),
            )
            return namespace

    @contextmanager
    def _transaction(self) -> Iterator[Connection]:
        try:
            with self.database.transaction() as connection:
                yield connection
        except WorkflowError:
            raise
        except UniqueViolation as error:
            raise NamespaceConflictError from error
        except (psycopg.OperationalError, PoolTimeout) as error:
            raise PersistenceUnavailableError from error
        except psycopg.Error as error:
            raise InternalPersistenceError from error


def _namespace_json(namespace: Namespace) -> dict[str, Any]:
    return namespace.model_dump(mode="json", by_alias=True)
