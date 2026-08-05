import type {
  BrowserbaseRunInput,
  BrowserbaseRunOutcome,
} from "@relay/automation-worker-browserbase";
import { describe, expect, it, vi } from "vitest";
import { BatchCoordinator } from "../src/batches/batch-coordinator.js";

const completedOutcome: BrowserbaseRunOutcome = {
  status: "completed",
  stage: "execution",
  result: {
    status: "completed",
    totalSteps: 2,
    passedSteps: 1,
    skippedSteps: 1,
    durationMs: 25,
  },
  cleanupStatus: "completed",
};

function workflowId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function batchInputs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    workflowId: workflowId(index + 1),
    workflow: { id: workflowId(index + 1), privateUrl: `https://private-${index}.example` },
  }));
}

function controlledRuns(capacity: number) {
  const pending: Array<{
    input: Omit<BrowserbaseRunInput, "signal">;
    finish(outcome: BrowserbaseRunOutcome): void;
  }> = [];
  let active = 0;
  const tryStart = vi.fn((input: Omit<BrowserbaseRunInput, "signal">) => {
    if (active >= capacity) return undefined;
    active += 1;
    input.onEvent?.({ type: "worker.started" });
    let finish!: (outcome: BrowserbaseRunOutcome) => void;
    const promise = new Promise<BrowserbaseRunOutcome>((resolve) => {
      finish = resolve;
    }).finally(() => {
      active -= 1;
    });
    pending.push({ input, finish });
    return promise;
  });
  return { pending, tryStart };
}

describe("BatchCoordinator", () => {
  it("starts five runs and leaves the sixth queued until a slot is released", async () => {
    const runs = controlledRuns(5);
    const coordinator = new BatchCoordinator({
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      tryStart: runs.tryStart,
    });

    const created = coordinator.createBatch(batchInputs(6));

    expect(created).toEqual({
      batchId: "11111111-1111-4111-8111-111111111111",
      runCount: 6,
    });
    expect(runs.tryStart).toHaveBeenCalledTimes(6);
    expect(coordinator.getBatch(created!.batchId)?.runs.map((run) => run.status)).toEqual([
      "running",
      "running",
      "running",
      "running",
      "running",
      "queued",
    ]);

    runs.pending[0]!.finish(completedOutcome);
    await vi.waitFor(() => expect(runs.pending).toHaveLength(6));

    expect(coordinator.getBatch(created!.batchId)?.runs.at(-1)?.status).toBe("running");
  });

  it("projects completed and skipped progress without exposing private input", async () => {
    const runs = controlledRuns(1);
    const coordinator = new BatchCoordinator({
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
      tryStart: runs.tryStart,
    });
    const created = coordinator.createBatch(batchInputs(1))!;
    const input = runs.pending[0]!.input;

    input.onEvent?.({ type: "run.started", totalSteps: 2 });
    input.onEvent?.({ type: "step.completed", stepId: "private-step", stepIndex: 0, durationMs: 10 });
    input.onEvent?.({
      type: "step.skipped",
      stepId: "private-skipped-step",
      stepIndex: 1,
      reason: "disabled",
    });
    expect(coordinator.getBatch(created.batchId)?.runs[0]).toEqual({
      workflowId: workflowId(1),
      status: "running",
      currentStep: 2,
      totalSteps: 2,
    });

    runs.pending[0]!.finish(completedOutcome);
    await vi.waitFor(() =>
      expect(coordinator.getBatch(created.batchId)?.runs[0]?.status).toBe("completed"),
    );

    const snapshot = coordinator.getBatch(created.batchId)!;
    expect(snapshot.runs[0]).toEqual({
      workflowId: workflowId(1),
      status: "completed",
      currentStep: 2,
      totalSteps: 2,
      passedSteps: 1,
      skippedSteps: 1,
      durationMs: 25,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-|privateUrl|"workflow":/);
  });

  it("continues after a failed run and maps cancellation to a safe failure", async () => {
    const runs = controlledRuns(1);
    const coordinator = new BatchCoordinator({
      randomUUID: () => "33333333-3333-4333-8333-333333333333",
      tryStart: runs.tryStart,
    });
    const created = coordinator.createBatch(batchInputs(2))!;

    runs.pending[0]!.finish({
      status: "cancelled",
      stage: "execution",
      cleanupStatus: "completed",
    });
    await vi.waitFor(() => expect(runs.pending).toHaveLength(2));

    expect(coordinator.getBatch(created.batchId)?.runs).toMatchObject([
      { status: "failed", code: "cancelled" },
      { status: "running" },
    ]);
  });

  it("expires terminal batches and never evicts active batches", async () => {
    let now = 1_000;
    const runs = controlledRuns(1);
    const coordinator = new BatchCoordinator({
      maximumBatches: 1,
      now: () => now,
      randomUUID: () => workflowId(now),
      terminalTtlMs: 100,
      tryStart: runs.tryStart,
    });
    const first = coordinator.createBatch(batchInputs(1))!;

    expect(coordinator.createBatch(batchInputs(1))).toBeUndefined();
    runs.pending[0]!.finish(completedOutcome);
    await vi.waitFor(() =>
      expect(coordinator.getBatch(first.batchId)?.runs[0]?.status).toBe("completed"),
    );
    now += 101;

    expect(coordinator.getBatch(first.batchId)).toBeUndefined();
    expect(coordinator.createBatch(batchInputs(1))).toBeDefined();
  });
});
