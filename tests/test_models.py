from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from uuid import UUID

import pytest
import yaml
from jsonschema import Draft202012Validator
from pydantic import ValidationError
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from relay_backend.models.namespaces import CreateNamespaceRequest
from relay_backend.models.workflows import (
    SaveWorkflowRequest,
    Workflow,
    canonical_request_hash,
    to_workflow_summary,
)


def workflow_document() -> dict:
    return {
        "schemaVersion": "1.2",
        "id": "b4749f7e-4b22-43bf-8ef4-8ba5f79cb17b",
        "name": "  Checkout flow  ",
        "status": "draft",
        "revision": 1,
        "createdAt": "2026-07-30T12:00:00Z",
        "updatedAt": "2026-07-30T12:00:00Z",
        "source": {
            "provider": "browserbase",
            "sessionId": "sensitive-session",
            "startUrl": "https://shop.example",
        },
        "steps": [
            {
                "id": "fill-card",
                "order": 1,
                "name": "  Fill card number  ",
                "enabled": True,
                "page": {"id": "page-1", "url": "https://shop.example/checkout"},
                "target": {"selector": "#card"},
                "metadata": {
                    "recordedAt": "2026-07-30T12:00:01Z",
                    "origin": "recorded",
                    "sensitive": True,
                },
                "type": "fill",
                "payload": {"value": "4111111111111111"},
                "parameterBinding": {"source": "recorded"},
            },
            {
                "id": "open-shop",
                "order": 0,
                "name": "Open shop",
                "enabled": True,
                "page": {"id": "page-1", "url": "https://shop.example"},
                "metadata": {
                    "recordedAt": "2026-07-30T12:00:00Z",
                    "origin": "manual",
                    "sensitive": False,
                },
                "type": "navigate",
                "payload": {"url": "https://shop.example"},
            },
        ],
    }


def test_workflow_trims_canonical_names() -> None:
    workflow = Workflow.model_validate(workflow_document())

    assert workflow.name == "Checkout flow"
    assert workflow.steps[0].name == "Fill card number"


def test_workflow_rejects_unexpected_properties() -> None:
    document = workflow_document()
    document["secretExtra"] = "must not be accepted"

    with pytest.raises(ValidationError):
        Workflow.model_validate(document)


@pytest.mark.parametrize(
    ("field", "coerced_value"),
    [
        ("enabled", "true"),
        ("order", "1"),
    ],
)
def test_workflow_rejects_coercive_primitive_values(
    field: str,
    coerced_value: str,
) -> None:
    document = workflow_document()
    document["steps"][0][field] = coerced_value

    with pytest.raises(ValidationError):
        Workflow.model_validate(document)


def test_element_steps_require_a_replayable_target() -> None:
    document = workflow_document()
    document["steps"][0]["target"] = {}

    with pytest.raises(ValidationError):
        Workflow.model_validate(document)


@pytest.mark.parametrize(
    ("step_type", "fields"),
    [
        ("click", {}),
        (
            "set_date",
            {"payload": {"value": "2026-07-30"}},
        ),
        (
            "select",
            {"payload": {"value": "us", "label": "United States"}},
        ),
        ("check", {}),
        ("uncheck", {}),
        (
            "keypress",
            {"payload": {"key": "Enter", "modifiers": ["Control"]}},
        ),
        ("submit", {}),
    ],
)
def test_all_element_step_variants_match_the_contract(
    step_type: str,
    fields: dict,
) -> None:
    document = workflow_document()
    step = deepcopy(document["steps"][0])
    step.pop("parameterBinding")
    step["type"] = step_type
    step.update(fields)
    if "payload" not in fields:
        step.pop("payload")
    document["steps"] = [step]

    workflow = Workflow.model_validate(document)

    assert workflow.steps[0].type == step_type
    _assert_matches_contract(workflow)


@pytest.mark.parametrize(
    "binding",
    [
        {"source": "recorded"},
        {"source": "fixed", "value": "secret"},
        {"source": "profile", "field": "identity.email"},
        {"source": "runtime"},
    ],
)
def test_all_parameter_bindings_match_the_contract(binding: dict) -> None:
    document = workflow_document()
    document["steps"] = [document["steps"][0]]
    document["steps"][0]["parameterBinding"] = binding

    workflow = Workflow.model_validate(document)

    _assert_matches_contract(workflow)


def test_summary_contains_only_safe_fields_and_sorts_steps() -> None:
    summary = to_workflow_summary(Workflow.model_validate(workflow_document()))
    dumped = summary.model_dump(mode="json", by_alias=True)

    assert dumped == {
        "id": "b4749f7e-4b22-43bf-8ef4-8ba5f79cb17b",
        "name": "Checkout flow",
        "status": "draft",
        "updatedAt": "2026-07-30T12:00:00Z",
        "steps": [
            {"id": "open-shop", "name": "Open shop", "order": 0},
            {"id": "fill-card", "name": "Fill card number", "order": 1},
        ],
    }
    assert "4111111111111111" not in repr(dumped)
    assert "sensitive-session" not in repr(dumped)


def test_canonical_request_hash_ignores_json_property_order() -> None:
    request = SaveWorkflowRequest.model_validate(
        {"workflow": workflow_document(), "expectedRevision": 1}
    )
    reordered = {
        "expectedRevision": 1,
        "workflow": deepcopy(workflow_document()),
    }

    assert canonical_request_hash("PUT", "/v1/workflows/abc", request) == (
        canonical_request_hash(
            "PUT",
            "/v1/workflows/abc",
            SaveWorkflowRequest.model_validate(reordered),
        )
    )
    assert canonical_request_hash("POST", "/v1/workflows/abc", request) != (
        canonical_request_hash("PUT", "/v1/workflows/abc", request)
    )


def test_validated_workflow_matches_authoritative_openapi_schema() -> None:
    workflow = Workflow.model_validate(workflow_document())

    _assert_matches_contract(workflow)
    assert workflow.id == UUID("b4749f7e-4b22-43bf-8ef4-8ba5f79cb17b")
    assert workflow.created_at == datetime(2026, 7, 30, 12, tzinfo=UTC)


def test_namespace_name_is_trimmed_before_length_validation() -> None:
    assert CreateNamespaceRequest(name="  Acme  ").name == "Acme"

    with pytest.raises(ValidationError):
        CreateNamespaceRequest(name="   ")
    with pytest.raises(ValidationError):
        CreateNamespaceRequest(name=f"  {'a' * 101}  ")


def _assert_matches_contract(workflow: Workflow) -> None:
    with open("openapi.yaml", encoding="utf-8") as contract_file:
        contract = yaml.safe_load(contract_file)
    registry = Registry().with_resource(
        "urn:relay-openapi",
        Resource.from_contents(contract, default_specification=DRAFT202012),
    )
    validator = Draft202012Validator(
        {"$ref": "urn:relay-openapi#/components/schemas/Workflow"},
        registry=registry,
    )

    errors = list(
        validator.iter_errors(workflow.model_dump(mode="json", by_alias=True, exclude_none=True))
    )

    assert errors == []
