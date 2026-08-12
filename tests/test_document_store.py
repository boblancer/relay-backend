from __future__ import annotations

import hashlib
import io
import json

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from relay_backend.document_store import S3WorkflowDocumentStore
from relay_backend.errors import InternalPersistenceError, PersistenceUnavailableError
from relay_backend.models.workflows import Workflow
from relay_backend.request_limits import MAX_REQUEST_BYTES
from tests.test_models import workflow_document


class FakeS3Client:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.put_error: Exception | None = None
        self.get_error: Exception | None = None

    def put_object(
        self,
        *,
        Bucket: str,
        Key: str,
        Body: bytes,
        ContentType: str,
    ) -> None:
        assert ContentType == "application/json"
        if self.put_error is not None:
            raise self.put_error
        self.objects[(Bucket, Key)] = Body

    def get_object(self, *, Bucket: str, Key: str) -> dict:
        if self.get_error is not None:
            raise self.get_error
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}


@pytest.fixture
def workflow() -> Workflow:
    return Workflow.model_validate(workflow_document())


@pytest.fixture
def client() -> FakeS3Client:
    return FakeS3Client()


@pytest.fixture
def store(client: FakeS3Client) -> S3WorkflowDocumentStore:
    return S3WorkflowDocumentStore(client, bucket="relay-workflows")


def test_put_uses_an_immutable_content_addressed_key(
    store: S3WorkflowDocumentStore,
    client: FakeS3Client,
    workflow: Workflow,
) -> None:
    object_key = store.put(workflow)
    body = client.objects[("relay-workflows", object_key)]
    digest = hashlib.sha256(body).hexdigest()

    assert object_key == f"workflows/{workflow.id}/{workflow.revision}-{digest}.json"
    assert json.loads(body) == workflow.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert store.put(workflow) == object_key


def test_get_returns_a_validated_canonical_workflow(
    store: S3WorkflowDocumentStore,
    workflow: Workflow,
) -> None:
    object_key = store.put(workflow)

    assert store.get(object_key) == workflow


@pytest.mark.parametrize(
    "body",
    [
        b"not-json",
        json.dumps({"schemaVersion": "1.2"}).encode(),
        b"x" * (MAX_REQUEST_BYTES + 1),
    ],
)
def test_get_rejects_invalid_or_oversized_documents(
    store: S3WorkflowDocumentStore,
    client: FakeS3Client,
    body: bytes,
) -> None:
    client.objects[("relay-workflows", "unsafe-object")] = body

    with pytest.raises(InternalPersistenceError):
        store.get("unsafe-object")


def test_missing_objects_are_safe_internal_failures(
    store: S3WorkflowDocumentStore,
    client: FakeS3Client,
) -> None:
    client.get_error = ClientError(
        {"Error": {"Code": "NoSuchKey", "Message": "sensitive object key"}},
        "GetObject",
    )

    with pytest.raises(InternalPersistenceError) as caught:
        store.get("private/key.json")

    assert "private/key.json" not in str(caught.value)
    assert "sensitive object key" not in str(caught.value)


@pytest.mark.parametrize("operation", ["put", "get"])
def test_connectivity_failures_map_to_safe_unavailable_errors(
    store: S3WorkflowDocumentStore,
    client: FakeS3Client,
    workflow: Workflow,
    operation: str,
) -> None:
    error = EndpointConnectionError(endpoint_url="https://private.example")
    if operation == "put":
        client.put_error = error

        def action() -> object:
            return store.put(workflow)

    else:
        client.get_error = error

        def action() -> object:
            return store.get("private/key.json")

    with pytest.raises(PersistenceUnavailableError) as caught:
        action()

    assert "private.example" not in str(caught.value)
