from __future__ import annotations

import hashlib
import json
from enum import StrEnum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

NonEmptyString = Annotated[str, StringConstraints(min_length=1)]
StrictBoolean = Annotated[bool, Field(strict=True)]
StrictNumber = Annotated[float, Field(strict=True)]


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        allow_inf_nan=False,
        extra="forbid",
        populate_by_name=True,
    )


class ErrorCode(StrEnum):
    UNAUTHORIZED = "unauthorized"
    VALIDATION_FAILED = "validation_failed"
    NOT_FOUND = "not_found"
    REVISION_CONFLICT = "revision_conflict"
    IDEMPOTENCY_CONFLICT = "idempotency_conflict"
    NAMESPACE_CONFLICT = "namespace_conflict"
    UNAVAILABLE = "unavailable"
    INTERNAL = "internal"
    AUTOMATION_UNAVAILABLE = "automation_unavailable"


class ErrorDetail(ApiModel):
    code: ErrorCode
    message: NonEmptyString


class ErrorResponse(ApiModel):
    error: ErrorDetail


class WorkflowStatus(StrEnum):
    DRAFT = "draft"
    COMPLETE = "complete"


class WorkflowSource(ApiModel):
    provider: Literal["browserbase"]
    session_id: str
    start_url: str | None = None


class LocatorKind(StrEnum):
    TEST_ID = "testId"
    ROLE = "role"
    ACCESSIBLE_NAME = "accessibleName"
    LABEL = "label"
    TEXT = "text"
    CSS = "css"
    XPATH = "xpath"


class LocatorCandidate(ApiModel):
    kind: LocatorKind
    value: NonEmptyString
    name: str | None = None
    exact: StrictBoolean = True
    unique: StrictBoolean | None = None


class ElementTarget(ApiModel):
    selector: NonEmptyString | None = None
    role: NonEmptyString | None = None
    name: NonEmptyString | None = None
    text: NonEmptyString | None = None
    tag_name: str | None = None
    input_type: str | None = None
    frame_url: str | None = None
    candidates: list[LocatorCandidate] | None = None


class ReplayableElementTarget(ElementTarget):
    @model_validator(mode="after")
    def require_replayable_locator(self) -> ReplayableElementTarget:
        if not any(
            (
                self.selector,
                self.role,
                self.name,
                self.text,
                self.candidates,
            )
        ):
            raise ValueError("A replayable target requires at least one locator.")
        return self


class PageDescriptor(ApiModel):
    id: NonEmptyString
    url: str
    title: str | None = None


class StepOrigin(StrEnum):
    RECORDED = "recorded"
    MANUAL = "manual"


class StepMetadata(ApiModel):
    recorded_at: AwareDatetime
    origin: StepOrigin
    sensitive: StrictBoolean


class ViewportPosition(ApiModel):
    x: StrictNumber
    y: StrictNumber
    frame_url: str | None = None


class ReplayWaitState(StrEnum):
    VISIBLE = "visible"
    HIDDEN = "hidden"


class ReplayWaitCondition(ApiModel):
    state: ReplayWaitState
    target: ReplayableElementTarget


class ReplayWait(ApiModel):
    delay_ms: int | None = Field(default=None, strict=True, ge=0, le=30_000)
    condition: ReplayWaitCondition | None = None

    @model_validator(mode="after")
    def require_condition_or_positive_delay(self) -> ReplayWait:
        if self.condition is None and (self.delay_ms is None or self.delay_ms < 1):
            raise ValueError("A replay wait requires a condition or positive delay.")
        return self


class RecordedParameterBinding(ApiModel):
    source: Literal["recorded"]


class FixedParameterBinding(ApiModel):
    source: Literal["fixed"]
    value: str = Field(max_length=10_000)


class ProfileField(StrEnum):
    FULL_NAME = "identity.fullName"
    EMAIL = "identity.email"
    COUNTRY_REGION = "location.countryRegion"
    POSTAL_CODE = "location.postalCode"


class ProfileParameterBinding(ApiModel):
    source: Literal["profile"]
    field: ProfileField


class RuntimeParameterBinding(ApiModel):
    source: Literal["runtime"]


ParameterBinding = Annotated[
    RecordedParameterBinding
    | FixedParameterBinding
    | ProfileParameterBinding
    | RuntimeParameterBinding,
    Field(discriminator="source"),
]


class EmptyPayload(ApiModel):
    pass


class NavigatePayload(ApiModel):
    url: NonEmptyString


class FillPayload(ApiModel):
    value: str


class SetDatePayload(ApiModel):
    value: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


class SelectPayload(ApiModel):
    value: str
    label: str | None = None


class KeyModifier(StrEnum):
    ALT = "Alt"
    CONTROL = "Control"
    META = "Meta"
    SHIFT = "Shift"


class KeypressPayload(ApiModel):
    key: NonEmptyString
    modifiers: list[KeyModifier]


class StepBase(ApiModel):
    id: NonEmptyString
    order: int = Field(strict=True, ge=0)
    name: NonEmptyString
    enabled: StrictBoolean
    page: PageDescriptor
    target: ElementTarget | None = None
    position: ViewportPosition | None = None
    wait_after: ReplayWait | None = None
    metadata: StepMetadata

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Step names cannot be empty.")
        return trimmed


class ElementStepBase(StepBase):
    target: ReplayableElementTarget


class NavigateStep(StepBase):
    type: Literal["navigate"]
    payload: NavigatePayload


class ClickStep(ElementStepBase):
    type: Literal["click"]
    payload: EmptyPayload | None = None


class FillStep(ElementStepBase):
    type: Literal["fill"]
    payload: FillPayload
    parameter_binding: ParameterBinding


class SetDateStep(ElementStepBase):
    type: Literal["set_date"]
    payload: SetDatePayload


class SelectStep(ElementStepBase):
    type: Literal["select"]
    payload: SelectPayload


class CheckStep(ElementStepBase):
    type: Literal["check"]
    payload: EmptyPayload | None = None


class UncheckStep(ElementStepBase):
    type: Literal["uncheck"]
    payload: EmptyPayload | None = None


class KeypressStep(ElementStepBase):
    type: Literal["keypress"]
    payload: KeypressPayload


class SubmitStep(ElementStepBase):
    type: Literal["submit"]
    payload: EmptyPayload | None = None


WorkflowStep = Annotated[
    NavigateStep
    | ClickStep
    | FillStep
    | SetDateStep
    | SelectStep
    | CheckStep
    | UncheckStep
    | KeypressStep
    | SubmitStep,
    Field(discriminator="type"),
]


class Workflow(ApiModel):
    schema_version: Literal["1.2"]
    id: UUID
    name: NonEmptyString
    status: WorkflowStatus
    revision: int = Field(strict=True, ge=1)
    created_at: AwareDatetime
    updated_at: AwareDatetime
    finished_at: AwareDatetime | None = None
    source: WorkflowSource
    steps: list[WorkflowStep]

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Workflow names cannot be empty.")
        return trimmed


class SaveWorkflowRequest(ApiModel):
    workflow: Workflow
    expected_revision: int = Field(strict=True, ge=1)


class WorkflowStepSummary(ApiModel):
    id: NonEmptyString
    name: NonEmptyString
    order: int = Field(strict=True, ge=0)


class WorkflowSummary(ApiModel):
    id: UUID
    name: NonEmptyString
    status: WorkflowStatus
    updated_at: AwareDatetime
    steps: list[WorkflowStepSummary]


class WorkflowListResponse(ApiModel):
    workflows: list[WorkflowSummary]


class RunWorkflowByIdRequest(ApiModel):
    model_config = ConfigDict(
        populate_by_name=False,
        validate_by_alias=True,
        validate_by_name=False,
    )

    workflow_id: UUID
    start_step_id: NonEmptyString | None = None
    parameter_values: dict[str, str] | None = None

    @field_validator("start_step_id", "parameter_values", mode="before")
    @classmethod
    def reject_explicit_null(cls, value: object) -> object:
        if value is None:
            raise ValueError("Optional run fields must be omitted instead of null.")
        return value


class BatchRunRequest(ApiModel):
    workflow: dict[str, Any]


class CreateBatchRequest(ApiModel):
    runs: list[BatchRunRequest] = Field(min_length=1, max_length=10)


def to_workflow_summary(workflow: Workflow) -> WorkflowSummary:
    return WorkflowSummary(
        id=workflow.id,
        name=workflow.name,
        status=workflow.status,
        updated_at=workflow.updated_at,
        steps=[
            WorkflowStepSummary(id=step.id, name=step.name, order=step.order)
            for step in sorted(workflow.steps, key=lambda item: item.order)
        ],
    )


def canonical_request_hash(
    method: str,
    path: str,
    request: ApiModel | None = None,
) -> bytes:
    request_json = ""
    if request is not None:
        request_json = json.dumps(
            request.model_dump(mode="json", by_alias=True, exclude_none=True),
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    identity = f"{method.upper()}\n{path}\n{request_json}".encode()
    return hashlib.sha256(identity).digest()
