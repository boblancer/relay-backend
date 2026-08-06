import type {
  BrowserbaseRunInput,
  BrowserbaseRunOutcome,
  BrowserbaseWorkerEvent,
  BrowserbaseWorkerFailureCode,
} from "@relay/automation-worker-browserbase";
import type { ThumbnailReference } from "../artifacts.js";

const defaultMaximumBatches = 100;
const defaultTerminalTtlMs = 60 * 60 * 1_000;

export type BatchRunStatus = "queued" | "running" | "completed" | "failed";
export type BatchFailureCode = BrowserbaseWorkerFailureCode | "cancelled" | "timed_out";
export type BatchFailurePhase = "acting" | "asserting" | "settling" | "waiting";

export interface BatchRunSnapshot {
  workflowId: string;
  status: BatchRunStatus;
  currentStep?: number;
  totalSteps?: number;
  passedSteps?: number;
  skippedSteps?: number;
  durationMs?: number;
  failedStepId?: string;
  failedStepIndex?: number;
  phase?: BatchFailurePhase;
  code?: BatchFailureCode;
  thumbnail?: ThumbnailReference;
}

export type ManagedRunOutcome = BrowserbaseRunOutcome & { thumbnail?: ThumbnailReference };

export interface BatchSnapshot {
  batchId: string;
  runs: BatchRunSnapshot[];
}

export interface BatchCreation {
  batchId: string;
  runCount: number;
}

export interface BatchRunInput {
  workflowId: string;
  workflow: object;
}

interface InternalBatchRun extends BatchRunSnapshot {
  privateInput?: object;
}

interface BatchRecord {
  batchId: string;
  completedAt?: number;
  runs: InternalBatchRun[];
}

interface BatchCoordinatorOptions {
  maximumBatches?: number;
  now?: () => number;
  randomUUID(): string;
  terminalTtlMs?: number;
  tryStart(
    input: Omit<BrowserbaseRunInput, "signal">,
  ): Promise<ManagedRunOutcome> | undefined;
}

function terminal(status: BatchRunStatus): boolean {
  return status === "completed" || status === "failed";
}

function snapshotRun(run: InternalBatchRun): BatchRunSnapshot {
  return {
    workflowId: run.workflowId,
    status: run.status,
    ...(run.currentStep === undefined ? {} : { currentStep: run.currentStep }),
    ...(run.totalSteps === undefined ? {} : { totalSteps: run.totalSteps }),
    ...(run.passedSteps === undefined ? {} : { passedSteps: run.passedSteps }),
    ...(run.skippedSteps === undefined ? {} : { skippedSteps: run.skippedSteps }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(run.failedStepId === undefined ? {} : { failedStepId: run.failedStepId }),
    ...(run.failedStepIndex === undefined ? {} : { failedStepIndex: run.failedStepIndex }),
    ...(run.phase === undefined ? {} : { phase: run.phase }),
    ...(run.code === undefined ? {} : { code: run.code }),
    ...(run.thumbnail === undefined ? {} : { thumbnail: run.thumbnail }),
  };
}

export class BatchCoordinator {
  private readonly batches = new Map<string, BatchRecord>();
  private readonly maximumBatches: number;
  private readonly now: () => number;
  private readonly queue: InternalBatchRun[] = [];
  private readonly terminalTtlMs: number;
  private stopping = false;

  constructor(private readonly options: BatchCoordinatorOptions) {
    this.maximumBatches = options.maximumBatches ?? defaultMaximumBatches;
    this.now = options.now ?? Date.now;
    this.terminalTtlMs = options.terminalTtlMs ?? defaultTerminalTtlMs;
  }

  createBatch(inputs: readonly BatchRunInput[]): BatchCreation | undefined {
    this.cleanupExpired();
    if (this.stopping || this.batches.size >= this.maximumBatches) return undefined;

    const batchId = this.options.randomUUID();
    const runs = inputs.map<InternalBatchRun>((input) => ({
      workflowId: input.workflowId,
      status: "queued",
      privateInput: input.workflow,
    }));
    this.batches.set(batchId, { batchId, runs });
    this.queue.push(...runs);
    this.drain();
    return { batchId, runCount: runs.length };
  }

  getBatch(batchId: string): BatchSnapshot | undefined {
    this.cleanupExpired();
    const record = this.batches.get(batchId);
    if (!record) return undefined;
    return { batchId: record.batchId, runs: record.runs.map(snapshotRun) };
  }

  drain(): void {
    if (this.stopping) return;
    while (this.queue.length) {
      const run = this.queue[0]!;
      const privateInput = run.privateInput;
      if (!privateInput) {
        this.queue.shift();
        continue;
      }
      const onEvent = (event: BrowserbaseWorkerEvent) => this.applyEvent(run, event);
      let started: Promise<BrowserbaseRunOutcome> | undefined;
      try {
        started = this.options.tryStart({ workflow: privateInput, onEvent });
      } catch {
        started = Promise.reject(new Error("run_start_failed"));
      }
      if (!started) return;

      this.queue.shift();
      void started
        .then((outcome) => this.applyOutcome(run, outcome))
        .catch(() =>
          this.applyOutcome(run, {
            status: "failed",
            stage: "execution",
            code: "automation_failed",
            cleanupStatus: "incomplete",
          }),
        )
        .finally(() => {
          run.privateInput = undefined;
          this.markBatchTerminal(run);
          this.drain();
        });
    }
  }

  stop(): void {
    this.stopping = true;
    for (const run of this.queue) run.privateInput = undefined;
    this.queue.length = 0;
  }

  private applyEvent(run: InternalBatchRun, event: BrowserbaseWorkerEvent): void {
    switch (event.type) {
      case "worker.started":
        run.status = "running";
        break;
      case "run.started":
        run.totalSteps = event.totalSteps;
        run.currentStep = 0;
        break;
      case "step.completed":
      case "step.skipped":
        run.currentStep = (run.currentStep ?? 0) + 1;
        break;
    }
  }

  private applyOutcome(run: InternalBatchRun, outcome: ManagedRunOutcome): void {
    run.status = outcome.status === "completed" ? "completed" : "failed";
    run.thumbnail = outcome.thumbnail;
    if (outcome.status === "failed") run.code = outcome.code;
    if (outcome.status === "cancelled" || outcome.status === "timed_out") {
      run.code = outcome.status;
    }
    if (!outcome.result) return;

    run.totalSteps = outcome.result.totalSteps;
    run.passedSteps = outcome.result.passedSteps;
    run.skippedSteps = outcome.result.skippedSteps;
    run.currentStep = outcome.result.passedSteps + outcome.result.skippedSteps;
    run.durationMs = outcome.result.durationMs;
    if (outcome.result.status !== "failed") return;
    run.failedStepId = outcome.result.failedStepId;
    run.failedStepIndex = outcome.result.failedStepIndex;
    run.phase = outcome.result.phase;
  }

  private markBatchTerminal(run: InternalBatchRun): void {
    for (const record of this.batches.values()) {
      if (!record.runs.includes(run)) continue;
      if (record.runs.every((candidate) => terminal(candidate.status))) {
        record.completedAt = this.now();
      }
      return;
    }
  }

  private cleanupExpired(): void {
    const cutoff = this.now() - this.terminalTtlMs;
    for (const [batchId, record] of this.batches) {
      if (record.completedAt !== undefined && record.completedAt <= cutoff) {
        this.batches.delete(batchId);
      }
    }
  }
}
