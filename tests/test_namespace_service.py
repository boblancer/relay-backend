from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import uuid4

import pytest

from relay_backend.data.database import Database
from relay_backend.errors import NamespaceConflictError
from relay_backend.models.namespaces import CreateNamespaceRequest, Namespace
from relay_backend.services.namespaces import NamespaceService
from tests.conftest import DATABASE_URL


@pytest.fixture
def namespace_service() -> NamespaceService:
    database = Database(DATABASE_URL, min_size=1, max_size=4)
    database.open()
    try:
        yield NamespaceService(
            database,
            clock=lambda: datetime(2026, 8, 11, 12, tzinfo=UTC),
        )
    finally:
        database.close()


def test_concurrent_duplicate_namespace_creation_has_one_winner(
    namespace_service: NamespaceService,
) -> None:
    def create() -> Namespace | NamespaceConflictError:
        try:
            return namespace_service.create(CreateNamespaceRequest(name="Acme"), uuid4())
        except NamespaceConflictError as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(lambda _: create(), range(2)))

    assert sum(isinstance(outcome, Namespace) for outcome in outcomes) == 1
    assert sum(isinstance(outcome, NamespaceConflictError) for outcome in outcomes) == 1
