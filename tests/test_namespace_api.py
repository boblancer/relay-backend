from __future__ import annotations

import base64
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from relay_backend.data.database import Database
from relay_backend.main import create_app
from relay_backend.services.namespaces import NamespaceService
from relay_backend.services.workflows import WorkflowService
from relay_backend.settings import Settings
from relay_backend.storage import LocalBlobStorage
from tests.conftest import DATABASE_URL


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    database = Database(DATABASE_URL, min_size=1, max_size=6)
    database.open()
    service = WorkflowService(database)
    storage = LocalBlobStorage(tmp_path)
    namespace_service = NamespaceService(database, storage)
    settings = Settings(
        database_url=DATABASE_URL,
        basic_auth_username="relay",
        basic_auth_password="test-password",
        _env_file=None,
    )
    token = base64.b64encode(b"relay:test-password").decode()
    app = create_app(settings=settings, service=service, namespace_service=namespace_service)
    try:
        with TestClient(
            app,
            headers={"Authorization": f"Basic {token}"},
        ) as test_client:
            yield test_client
    finally:
        database.close()


def test_list_namespaces_empty(client: TestClient) -> None:
    response = client.get("/v1/namespaces")

    assert response.status_code == 200
    assert response.json() == []


def test_create_namespace(client: TestClient) -> None:
    response = client.post("/v1/namespaces", json={"name": "my-namespace"})

    assert response.status_code == 201
    body = response.json()
    assert isinstance(body["id"], int)
    assert body["name"] == "my-namespace"


def test_get_namespace(client: TestClient) -> None:
    created = client.post("/v1/namespaces", json={"name": "fetch-me"}).json()

    response = client.get(f"/v1/namespaces/{created['id']}")

    assert response.status_code == 200
    assert response.json()["name"] == "fetch-me"


def test_create_duplicate_namespace(client: TestClient) -> None:
    client.post("/v1/namespaces", json={"name": "unique-name"})

    response = client.post("/v1/namespaces", json={"name": "unique-name"})

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "duplicate_name"


def test_get_nonexistent_namespace(client: TestClient) -> None:
    response = client.get("/v1/namespaces/999999")

    assert response.status_code == 404


def test_create_record(client: TestClient) -> None:
    ns = client.post("/v1/namespaces", json={"name": "ns-for-record"}).json()

    response = client.post(
        f"/v1/namespaces/{ns['id']}/records",
        json={"name": "my-record"},
    )

    assert response.status_code == 201
    body = response.json()
    assert isinstance(body["id"], int)
    assert body["namespaceId"] == ns["id"]


def test_list_records(client: TestClient) -> None:
    ns = client.post("/v1/namespaces", json={"name": "ns-list"}).json()
    client.post(f"/v1/namespaces/{ns['id']}/records", json={"name": "rec-1"})
    client.post(f"/v1/namespaces/{ns['id']}/records", json={"name": "rec-2"})

    response = client.get(f"/v1/namespaces/{ns['id']}/records")

    assert response.status_code == 200
    assert len(response.json()) == 2


def test_get_record(client: TestClient) -> None:
    ns = client.post("/v1/namespaces", json={"name": "ns-get-rec"}).json()
    created = client.post(
        f"/v1/namespaces/{ns['id']}/records",
        json={"name": "get-me"},
    ).json()

    response = client.get(f"/v1/namespaces/{ns['id']}/records/{created['id']}")

    assert response.status_code == 200
    assert response.json()["name"] == "get-me"


def test_get_nonexistent_record(client: TestClient) -> None:
    ns = client.post("/v1/namespaces", json={"name": "ns-missing-rec"}).json()

    response = client.get(f"/v1/namespaces/{ns['id']}/records/999999")

    assert response.status_code == 404


def test_upload_and_download_file(client: TestClient) -> None:
    ns = client.post("/v1/namespaces", json={"name": "ns-upload"}).json()
    rec = client.post(
        f"/v1/namespaces/{ns['id']}/records",
        json={"name": "file-rec"},
    ).json()
    content = b"hello world binary data"

    upload_response = client.post(
        f"/v1/namespaces/{ns['id']}/records/{rec['id']}/upload",
        files={"file": ("test.bin", content, "application/octet-stream")},
    )

    assert upload_response.status_code == 200
    assert "fileUrl" in upload_response.json()

    download_response = client.get(
        f"/v1/namespaces/{ns['id']}/records/{rec['id']}/download",
    )

    assert download_response.status_code == 200
    assert download_response.content == content


def test_download_without_upload(client: TestClient) -> None:
    ns = client.post("/v1/namespaces", json={"name": "ns-no-upload"}).json()
    rec = client.post(
        f"/v1/namespaces/{ns['id']}/records",
        json={"name": "empty-rec"},
    ).json()

    response = client.get(
        f"/v1/namespaces/{ns['id']}/records/{rec['id']}/download",
    )

    assert response.status_code == 404
