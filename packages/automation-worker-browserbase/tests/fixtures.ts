import type { Workflow, WorkflowStep } from "@relay/automation-core";

const recordedAt = "2026-08-02T12:00:00Z";

export function fillStep(
  id: string,
  parameterBinding: Extract<WorkflowStep, { type: "fill" }>["parameterBinding"],
  enabled = true,
): Extract<WorkflowStep, { type: "fill" }> {
  return {
    id,
    order: 0,
    name: "Fill field",
    enabled,
    page: { id: "page-1", url: "https://example.com/form" },
    target: { candidates: [{ kind: "testId", value: "field", exact: true }] },
    metadata: { recordedAt, origin: "recorded", sensitive: false },
    type: "fill",
    payload: { value: "recorded-value" },
    parameterBinding,
  };
}

export function navigateStep(): Extract<WorkflowStep, { type: "navigate" }> {
  return {
    id: "navigate",
    order: 0,
    name: "Open page",
    enabled: true,
    page: { id: "page-1", url: "https://example.com/form" },
    metadata: { recordedAt, origin: "recorded", sensitive: false },
    type: "navigate",
    payload: { url: "https://example.com/form" },
  };
}

export function assertionStep(
  expected = "ready",
): Extract<WorkflowStep, { type: "assertion" }> {
  return {
    id: "assertion",
    order: 0,
    name: "Check result",
    enabled: true,
    page: { id: "page-1", url: "https://example.com/form" },
    target: { candidates: [{ kind: "testId", value: "result", exact: true }] },
    metadata: { recordedAt, origin: "manual", sensitive: false },
    type: "assertion",
    expectation: { kind: "text_contains", expected },
  };
}

export function completeWorkflow(steps: WorkflowStep[]): Workflow {
  return {
    schemaVersion: "1.3",
    id: "05b6300c-27c4-4931-8e89-a4b2223d9d8e",
    name: "Worker fixture",
    status: "complete",
    revision: 1,
    createdAt: recordedAt,
    updatedAt: recordedAt,
    finishedAt: recordedAt,
    source: {
      provider: "browserbase",
      sessionId: "source-session-secret",
      startUrl: "https://example.com/start",
    },
    steps: steps.map((step, order) => ({ ...step, order })),
  };
}
