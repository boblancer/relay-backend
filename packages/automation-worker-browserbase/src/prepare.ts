import {
  WorkflowSchema,
  preflightAutomation,
  type AutomationPreflight,
  type Workflow,
} from "@relay/automation-core";

export type WorkerValidationCode =
  | "invalid_workflow"
  | "workflow_not_complete"
  | "invalid_start_step"
  | "no_enabled_steps"
  | "missing_parameter"
  | "invalid_parameter"
  | "unused_parameter";

export class WorkerValidationError extends Error {
  constructor(
    readonly code: WorkerValidationCode,
    readonly stepId?: string,
  ) {
    super("The automation run input is invalid.");
    this.name = "WorkerValidationError";
  }
}

export interface PreparedWorkflow {
  workflow: Workflow;
  preflight: AutomationPreflight;
}

const maxParameterValueLength = 10_000;

export function prepareWorkflow(
  input: unknown,
  startStepId: string | undefined,
  parameterValues: Readonly<Record<string, string>>,
): PreparedWorkflow {
  const parsed = WorkflowSchema.safeParse(input);
  if (!parsed.success) throw new WorkerValidationError("invalid_workflow");
  if (parsed.data.status !== "complete") {
    throw new WorkerValidationError("workflow_not_complete");
  }

  const duplicate = parsed.data.steps.find(
    (step, index) => parsed.data.steps.findIndex((candidate) => candidate.id === step.id) !== index,
  );
  if (duplicate) throw new WorkerValidationError("invalid_workflow", duplicate.id);

  const startIndex = startStepId
    ? parsed.data.steps.findIndex((step) => step.id === startStepId)
    : 0;
  if (startIndex < 0) throw new WorkerValidationError("invalid_start_step", startStepId);

  const range = parsed.data.steps.slice(startIndex);
  if (!range.some((step) => step.enabled)) {
    throw new WorkerValidationError("no_enabled_steps");
  }

  const requiredParameterIds = new Set(
    range
      .filter(
        (step) =>
          step.enabled &&
          step.type === "fill" &&
          ["profile", "runtime"].includes(step.parameterBinding.source),
      )
      .map((step) => step.id),
  );
  for (const stepId of Object.keys(parameterValues)) {
    if (!requiredParameterIds.has(stepId)) {
      throw new WorkerValidationError("unused_parameter", stepId);
    }
  }

  const steps = parsed.data.steps.map((step, index) => {
    if (index < startIndex || !step.enabled || step.type !== "fill") return step;
    if (step.parameterBinding.source === "recorded") return step;
    if (step.parameterBinding.source === "fixed") {
      if (!step.parameterBinding.value.length) {
        throw new WorkerValidationError("invalid_parameter", step.id);
      }
      return { ...step, payload: { value: step.parameterBinding.value } };
    }
    const value = parameterValues[step.id];
    if (value === undefined) throw new WorkerValidationError("missing_parameter", step.id);
    if (typeof value !== "string" || !value.length || value.length > maxParameterValueLength) {
      throw new WorkerValidationError("invalid_parameter", step.id);
    }
    return { ...step, payload: { value } };
  });
  const workflow = { ...parsed.data, steps };
  try {
    return { workflow, preflight: preflightAutomation(workflow, startStepId) };
  } catch {
    throw new WorkerValidationError("invalid_workflow");
  }
}
