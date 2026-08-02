import { WorkflowSchema, type Workflow } from "./workflow.js";

export interface AutomationPreflight {
  workflow: Workflow;
  startIndex: number;
  totalSteps: number;
  bootstrapUrl?: string;
}

export class AutomationPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationPreflightError";
  }
}

function validHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function preflightAutomation(input: unknown, startStepId?: string): AutomationPreflight {
  const workflow = WorkflowSchema.parse(input);
  const duplicate = workflow.steps.find(
    (step, index) => workflow.steps.findIndex((candidate) => candidate.id === step.id) !== index,
  );
  if (duplicate) throw new AutomationPreflightError("Workflow step IDs must be unique.");

  const startIndex = startStepId
    ? workflow.steps.findIndex((step) => step.id === startStepId)
    : 0;
  if (startIndex < 0) {
    throw new AutomationPreflightError(
      "The selected automation step is no longer in this workflow.",
    );
  }

  const range = workflow.steps.slice(startIndex);
  const firstEnabled = range.find((step) => step.enabled);
  if (!firstEnabled) {
    throw new AutomationPreflightError("The selected automation range has no enabled steps.");
  }

  const bootstrapUrl =
    firstEnabled.type === "navigate"
      ? undefined
      : validHttpUrl(workflow.source.startUrl)
        ? workflow.source.startUrl
        : validHttpUrl(firstEnabled.page.url)
          ? firstEnabled.page.url
          : undefined;
  if (firstEnabled.type !== "navigate" && !bootstrapUrl) {
    throw new AutomationPreflightError(
      "Automation needs a recorded HTTP page URL as its starting point.",
    );
  }

  return { workflow, startIndex, totalSteps: range.length, bootstrapUrl };
}
