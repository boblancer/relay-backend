import type { Workflow, WorkflowStep } from "../src/index.js";

const recordedAt = "2026-07-31T12:00:00Z";

export function clickStep(order = 0): Extract<WorkflowStep, { type: "click" }> {
  return {
    id: `step-${order}`,
    order,
    name: "Click continue",
    enabled: true,
    page: { id: "page-1", url: "https://example.com/form" },
    target: {
      candidates: [{ kind: "role", value: "button", name: "Continue", exact: true }],
    },
    metadata: { recordedAt, origin: "recorded", sensitive: false },
    type: "click",
  };
}

export function navigateStep(order = 0): Extract<WorkflowStep, { type: "navigate" }> {
  return {
    id: `step-${order}`,
    order,
    name: "Open form",
    enabled: true,
    page: { id: "page-1", url: "https://example.com/form" },
    metadata: { recordedAt, origin: "recorded", sensitive: false },
    type: "navigate",
    payload: { url: "https://example.com/form" },
  };
}

export function workflowWith(steps: WorkflowStep[]): Workflow {
  return {
    schemaVersion: "1.3",
    id: "05b6300c-27c4-4931-8e89-a4b2223d9d8e",
    name: "Example workflow",
    status: "complete",
    revision: 3,
    createdAt: "2026-07-31T12:00:00Z",
    updatedAt: "2026-07-31T12:05:00Z",
    finishedAt: "2026-07-31T12:05:00Z",
    source: {
      provider: "browserbase",
      sessionId: "recorded-session",
      startUrl: "https://example.com/start",
    },
    steps,
  };
}
