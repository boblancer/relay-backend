from __future__ import annotations

import hashlib

from relay_backend.document_store import serialize_workflow
from relay_backend.models.workflows import Workflow


class InMemoryWorkflowDocumentStore:
    def __init__(self) -> None:
        self.objects: dict[str, Workflow] = {}
        self.put_calls = 0
        self.get_calls = 0
        self.put_error: Exception | None = None
        self.get_error: Exception | None = None

    def put(self, workflow: Workflow) -> str:
        self.put_calls += 1
        if self.put_error is not None:
            raise self.put_error
        body = serialize_workflow(workflow)
        digest = hashlib.sha256(body).hexdigest()
        object_key = f"workflows/{workflow.id}/{workflow.revision}-{digest}.json"
        self.objects[object_key] = workflow.model_copy(deep=True)
        return object_key

    def get(self, object_key: str) -> Workflow:
        self.get_calls += 1
        if self.get_error is not None:
            raise self.get_error
        return self.objects[object_key].model_copy(deep=True)
