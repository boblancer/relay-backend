from __future__ import annotations

import hashlib
import json
from contextlib import closing
from typing import Any, Protocol

from botocore.exceptions import BotoCoreError, ClientError
from pydantic import ValidationError

from relay_backend.errors import InternalPersistenceError, PersistenceUnavailableError
from relay_backend.models.workflows import Workflow
from relay_backend.request_limits import MAX_REQUEST_BYTES


class WorkflowDocumentStore(Protocol):
    def put(self, workflow: Workflow) -> str: ...

    def get(self, object_key: str) -> Workflow: ...


class S3WorkflowDocumentStore:
    def __init__(self, client: Any, *, bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    def put(self, workflow: Workflow) -> str:
        body = serialize_workflow(workflow)
        digest = hashlib.sha256(body).hexdigest()
        object_key = f"workflows/{workflow.id}/{workflow.revision}-{digest}.json"
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=object_key,
                Body=body,
                ContentType="application/json",
            )
        except BotoCoreError as error:
            raise PersistenceUnavailableError from error
        except ClientError as error:
            _raise_client_error(error)
        return object_key

    def get(self, object_key: str) -> Workflow:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=object_key)
            with closing(response["Body"]) as stream:
                body = stream.read(MAX_REQUEST_BYTES + 1)
        except BotoCoreError as error:
            raise PersistenceUnavailableError from error
        except ClientError as error:
            _raise_client_error(error)
        except (AttributeError, KeyError, OSError, TypeError) as error:
            raise InternalPersistenceError from error

        if len(body) > MAX_REQUEST_BYTES:
            raise InternalPersistenceError
        try:
            return Workflow.model_validate_json(body)
        except (ValidationError, ValueError) as error:
            raise InternalPersistenceError from error


def serialize_workflow(workflow: Workflow) -> bytes:
    try:
        body = json.dumps(
            workflow.model_dump(mode="json", by_alias=True, exclude_none=True),
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
    except (TypeError, ValueError) as error:
        raise InternalPersistenceError from error
    if len(body) > MAX_REQUEST_BYTES:
        raise InternalPersistenceError
    return body


def _raise_client_error(error: ClientError) -> None:
    status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    code = error.response.get("Error", {}).get("Code", "")
    if (status is not None and status >= 500) or code in {
        "InternalError",
        "RequestTimeout",
        "ServiceUnavailable",
        "SlowDown",
        "Throttling",
    }:
        raise PersistenceUnavailableError from error
    raise InternalPersistenceError from error
