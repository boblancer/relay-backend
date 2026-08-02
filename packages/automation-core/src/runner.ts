import type { Page } from "playwright-core";
import {
  AutomationCancelledError,
  AutomationExecutionError,
  AutomationExecutor,
  type AutomationAttempt,
  type AutomationPhase,
} from "./execution.js";
import type { AutomationPreflight } from "./preflight.js";
import { isRedundantOptionClickBeforeSelect } from "./redundant-option-click.js";

export interface AutomationDiagnostic {
  message: string;
  attempts: AutomationAttempt[];
}

interface ResultBase {
  totalSteps: number;
  passedSteps: number;
  skippedSteps: number;
  durationMs: number;
}

export interface AutomationCompletedResult extends ResultBase {
  status: "completed";
}

export interface AutomationFailedResult extends ResultBase {
  status: "failed";
  failedStepId?: string;
  failedStepIndex?: number;
  phase: AutomationPhase;
  diagnostic: AutomationDiagnostic;
}

export interface AutomationCancelledResult extends ResultBase {
  status: "cancelled";
  currentStepId?: string;
  currentStepIndex?: number;
}

export type AutomationResult =
  | AutomationCompletedResult
  | AutomationFailedResult
  | AutomationCancelledResult;

export type AutomationEvent =
  | { type: "run.started"; totalSteps: number }
  | { type: "step.started"; stepId: string; stepIndex: number }
  | { type: "step.phase"; stepId: string; stepIndex: number; phase: AutomationPhase }
  | {
      type: "step.skipped";
      stepId: string;
      stepIndex: number;
      reason: "disabled" | "redundant-option-click";
    }
  | { type: "step.completed"; stepId: string; stepIndex: number; durationMs: number }
  | {
      type: "step.failed";
      stepId: string;
      stepIndex: number;
      phase: AutomationPhase;
      diagnostic: AutomationDiagnostic;
    }
  | { type: "step.cancelled"; stepId: string; stepIndex: number }
  | { type: "run.completed"; result: AutomationCompletedResult }
  | { type: "run.failed"; result: AutomationFailedResult }
  | { type: "run.cancelled"; result: AutomationCancelledResult };

export interface AutomationRunnerOptions {
  signal?: AbortSignal;
  onEvent?: (event: AutomationEvent) => void;
  /** Per-step browser deadline; defaults to 15 seconds. */
  stepTimeoutMs?: number;
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export class AutomationRunner {
  constructor(
    private readonly page: Page,
    private readonly options: AutomationRunnerOptions = {},
  ) {}

  private emit(event: AutomationEvent): void {
    this.options.onEvent?.(event);
  }

  async run(preflight: AutomationPreflight): Promise<AutomationResult> {
    const startedAt = Date.now();
    const steps = preflight.workflow.steps.slice(preflight.startIndex);
    let passedSteps = 0;
    let skippedSteps = 0;
    let currentStepId: string | undefined;
    let currentStepIndex: number | undefined;
    const executor = new AutomationExecutor(
      this.page,
      this.options.signal,
      this.options.stepTimeoutMs,
    );
    this.emit({ type: "run.started", totalSteps: preflight.totalSteps });

    try {
      if (this.options.signal?.aborted) throw new AutomationCancelledError();
      if (preflight.bootstrapUrl) await executor.openInitialPage(preflight.bootstrapUrl);

      for (let index = 0; index < steps.length; index += 1) {
        if (this.options.signal?.aborted) throw new AutomationCancelledError();
        const step = steps[index]!;
        const stepIndex = preflight.startIndex + index;
        if (!step.enabled) {
          skippedSteps += 1;
          this.emit({ type: "step.skipped", stepId: step.id, stepIndex, reason: "disabled" });
          continue;
        }
        if (isRedundantOptionClickBeforeSelect(step, steps[index + 1])) {
          skippedSteps += 1;
          this.emit({
            type: "step.skipped",
            stepId: step.id,
            stepIndex,
            reason: "redundant-option-click",
          });
          continue;
        }

        currentStepId = step.id;
        currentStepIndex = stepIndex;
        const stepStartedAt = Date.now();
        this.emit({ type: "step.started", stepId: step.id, stepIndex });
        try {
          await executor.runStep(step, (phase) =>
            this.emit({ type: "step.phase", stepId: step.id, stepIndex, phase }),
          );
          passedSteps += 1;
          this.emit({
            type: "step.completed",
            stepId: step.id,
            stepIndex,
            durationMs: elapsedSince(stepStartedAt),
          });
          currentStepId = undefined;
          currentStepIndex = undefined;
        } catch (error) {
          if (error instanceof AutomationCancelledError) throw error;
          const executionError =
            error instanceof AutomationExecutionError
              ? error
              : new AutomationExecutionError("The automation action could not be completed.");
          const diagnostic = {
            message: executionError.message,
            attempts: executionError.attempts,
          };
          const phase = executionError.phase ?? "acting";
          this.emit({
            type: "step.failed",
            stepId: step.id,
            stepIndex,
            phase,
            diagnostic,
          });
          const result: AutomationFailedResult = {
            status: "failed",
            totalSteps: preflight.totalSteps,
            passedSteps,
            skippedSteps,
            durationMs: elapsedSince(startedAt),
            failedStepId: step.id,
            failedStepIndex: stepIndex,
            phase,
            diagnostic,
          };
          this.emit({ type: "run.failed", result });
          return result;
        }
      }

      const result: AutomationCompletedResult = {
        status: "completed",
        totalSteps: preflight.totalSteps,
        passedSteps,
        skippedSteps,
        durationMs: elapsedSince(startedAt),
      };
      this.emit({ type: "run.completed", result });
      return result;
    } catch (error) {
      if (!(error instanceof AutomationCancelledError)) {
        const executionError =
          error instanceof AutomationExecutionError
            ? error
            : new AutomationExecutionError("The initial automation page could not be opened.");
        const result: AutomationFailedResult = {
          status: "failed",
          totalSteps: preflight.totalSteps,
          passedSteps,
          skippedSteps,
          durationMs: elapsedSince(startedAt),
          phase: executionError.phase ?? "acting",
          diagnostic: { message: executionError.message, attempts: executionError.attempts },
        };
        this.emit({ type: "run.failed", result });
        return result;
      }
      if (currentStepId !== undefined && currentStepIndex !== undefined) {
        this.emit({ type: "step.cancelled", stepId: currentStepId, stepIndex: currentStepIndex });
      }
      const result: AutomationCancelledResult = {
        status: "cancelled",
        totalSteps: preflight.totalSteps,
        passedSteps,
        skippedSteps,
        durationMs: elapsedSince(startedAt),
        ...(currentStepId === undefined ? {} : { currentStepId }),
        ...(currentStepIndex === undefined ? {} : { currentStepIndex }),
      };
      this.emit({ type: "run.cancelled", result });
      return result;
    } finally {
      executor.dispose();
    }
  }
}
