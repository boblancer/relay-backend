import type {
  BrowserbaseAutomationWorker,
  BrowserbaseRunInput,
  BrowserbaseRunOutcome,
  BrowserbaseWorkerConfig,
} from "@relay/automation-worker-browserbase";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAutomationService, type SafeLogRecord } from "../src/app.js";
import type { AutomationServiceConfig } from "../src/config.js";
import type { InngestRunExecutor } from "../src/inngest.js";

const config: AutomationServiceConfig = {
  artifactDirectory: "/tmp/relay-test-artifacts",
  host: "127.0.0.1",
  inngestDev: false,
  port: 8080,
  maxConcurrentRuns: 1,
  retryAfterSeconds: 2,
  screenshotsEnabled: false,
  shutdownGraceMs: 30_000,
  worker: {
    apiKey: "private-browserbase-key",
    region: "us-west-2",
    runTimeoutMs: 600_000,
    stepTimeoutMs: 60_000,
    useProxy: false,
    verified: false,
  },
};

const requestBody = {
  workflow: { schemaVersion: "1.3", status: "complete" },
  parameterValues: { fill: "private-parameter-value" },
};

const completedOutcome: BrowserbaseRunOutcome = {
  status: "completed",
  stage: "execution",
  result: {
    status: "completed",
    totalSteps: 1,
    passedSteps: 1,
    skippedSteps: 0,
    durationMs: 10,
  },
  cleanupStatus: "completed",
};

function fixture(
  run: (input: BrowserbaseRunInput) => Promise<BrowserbaseRunOutcome> = async (input) => {
    input.onEvent?.({ type: "worker.started" });
    input.onEvent?.({ type: "run.started", totalSteps: 1 });
    return completedOutcome;
  },
  overrides: Partial<AutomationServiceConfig> = {},
) {
  const logs: SafeLogRecord[] = [];
  const createWorker = vi.fn((_workerConfig: BrowserbaseWorkerConfig) => ({ run })) as unknown as (
    workerConfig: BrowserbaseWorkerConfig,
  ) => BrowserbaseAutomationWorker;
  const registerInngest = vi.fn();
  const service = buildAutomationService(
    { ...config, ...overrides },
    {
      createWorker,
      log: (record) => logs.push(record),
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      registerInngest,
    },
  );
  return { createWorker, logs, registerInngest, run, service };
}

function runHeaders(accept = "application/x-ndjson") {
  return {
    accept,
    "content-type": "application/json",
  };
}

function batchHeaders() {
  return {
    accept: "application/json",
    "content-type": "application/json",
  };
}

function batchWorkflow(index: number) {
  return {
    schemaVersion: "1.3",
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    status: "complete",
    privateName: `private-workflow-${index}`,
    privateUrl: `https://private-${index}.example`,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("automation service contract", () => {
  it("registers Inngest only when the local POC is enabled", async () => {
    const disabled = fixture();
    const enabled = fixture(undefined, { inngestDev: true });
    const missingRoute = await disabled.service.app.inject({
      method: "GET",
      url: "/api/inngest",
    });

    expect(disabled.registerInngest).not.toHaveBeenCalled();
    expect(missingRoute.statusCode).toBe(404);
    expect(enabled.registerInngest).toHaveBeenCalledOnce();

    await disabled.service.shutdown();
    await enabled.service.shutdown();
  });

  it("does not request terminal screenshots for Inngest work", async () => {
    let inngestExecute!: InngestRunExecutor;
    let observedInput!: BrowserbaseRunInput;
    const run = vi.fn(async (input: BrowserbaseRunInput) => {
      observedInput = input;
      return completedOutcome;
    });
    const service = buildAutomationService(
      { ...config, inngestDev: true, screenshotsEnabled: true },
      {
        createWorker: vi.fn(() => ({ run })) as unknown as (
          workerConfig: BrowserbaseWorkerConfig,
        ) => BrowserbaseAutomationWorker,
        log: vi.fn(),
        randomUUID: () => "11111111-1111-4111-8111-111111111111",
        registerInngest: vi.fn((_app, execute: InngestRunExecutor) => {
          inngestExecute = execute;
        }),
      },
    );

    const result = await inngestExecute({ workflow: { schemaVersion: "1.3" } });

    expect(result).toEqual({ accepted: true, outcome: completedOutcome });
    expect(observedInput.onTerminalScreenshot).toBeUndefined();
    await service.shutdown();
  });

  it("shares local capacity between direct and Inngest runs", async () => {
    let finish!: (outcome: BrowserbaseRunOutcome) => void;
    let inngestExecute!: InngestRunExecutor;
    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const run = vi.fn(
      (input: BrowserbaseRunInput) =>
        new Promise<BrowserbaseRunOutcome>((resolve) => {
          finish = resolve;
          input.onEvent?.({ type: "worker.started" });
          markRunStarted();
        }),
    );
    const service = buildAutomationService(
      { ...config, inngestDev: true },
      {
        createWorker: vi.fn(() => ({ run })) as unknown as (
          workerConfig: BrowserbaseWorkerConfig,
        ) => BrowserbaseAutomationWorker,
        log: vi.fn(),
        randomUUID: () => "11111111-1111-4111-8111-111111111111",
        registerInngest: vi.fn((_app, execute: InngestRunExecutor) => {
          inngestExecute = execute;
        }),
      },
    );
    const directRun = service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });
    await runStarted;

    const admission = await inngestExecute({ workflow: { schemaVersion: "1.3" } });

    expect(admission).toEqual({ accepted: false, code: "at_capacity" });
    finish(completedOutcome);
    await directRun;
    await service.shutdown();
  });

  it("serves unauthenticated liveness and readiness checks", async () => {
    const { service } = fixture();

    await expect(service.app.inject({ method: "GET", url: "/health/live" })).resolves.toMatchObject({
      statusCode: 200,
      json: expect.any(Function),
    });
    expect((await service.app.inject({ method: "GET", url: "/health/live" })).json()).toEqual({
      status: "ok",
    });
    expect((await service.app.inject({ method: "GET", url: "/health/ready" })).json()).toEqual({
      status: "ok",
    });

    await service.shutdown();
  });

  it.each([
    [{ accept: "application/x-ndjson", "content-type": "application/json" }, 200, undefined],
    [
      {
        accept: "application/x-ndjson",
        authorization: "Bearer arbitrary-ignored-token",
        "content-type": "application/json",
      },
      200,
      undefined,
    ],
    [{ accept: "application/json", "content-type": "application/json" }, 406, "not_acceptable"],
    [
      {
        accept: "application/x-ndjson;q=0",
        "content-type": "application/json",
      },
      406,
      "not_acceptable",
    ],
  ])("allows unauthenticated callers while enforcing media negotiation", async (headers, statusCode, code) => {
    const { service } = fixture();
    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers,
      payload: requestBody,
    });

    expect(response.statusCode).toBe(statusCode);
    if (code) expect(response.json()).toMatchObject({ error: { code } });
    expect(response.body).not.toMatch(/private-parameter-value|private-browserbase-key/);
    await service.shutdown();
  });

  it("enforces JSON media type and a strict top-level request", async () => {
    const { service } = fixture();
    const wrongMedia = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "text/plain",
      },
      payload: "private-body",
    });
    const extraField = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: { ...requestBody, provider: { verified: true } },
    });

    expect(wrongMedia.statusCode).toBe(415);
    expect(wrongMedia.json()).toMatchObject({ error: { code: "unsupported_media_type" } });
    expect(extraField.statusCode).toBe(400);
    expect(extraField.json()).toMatchObject({ error: { code: "invalid_request" } });
    await service.shutdown();
  });

  it("rejects requests larger than 1 MiB without echoing their content", async () => {
    const { service } = fixture();
    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: { workflow: { padding: `oversized-secret-${"x".repeat(1_048_576)}` } },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: "request_too_large" } });
    expect(response.body).not.toContain("oversized-secret");
    await service.shutdown();
  });

  it("returns a safe 422 without starting a stream when worker preflight fails", async () => {
    const run = vi.fn(async () => ({
      status: "failed" as const,
      stage: "validation" as const,
      code: "missing_parameter" as const,
      cleanupStatus: "not_started" as const,
    }));
    const { service } = fixture(run);

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      error: {
        code: "missing_parameter",
        message: "The automation run input is invalid.",
      },
    });
    await service.shutdown();
  });

  it("streams safe events with one run ID and one terminal outcome", async () => {
    const { logs, service } = fixture();

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });
    const lines = response.body.trim().split("\n").map((line) => JSON.parse(line));

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.headers["x-run-id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(lines.map((line) => line.type)).toEqual([
      "worker.started",
      "run.started",
      "worker.outcome",
    ]);
    expect(lines.every((line) => line.runId === response.headers["x-run-id"])).toBe(true);
    expect(lines.filter((line) => line.type === "worker.outcome")).toHaveLength(1);
    expect(JSON.stringify({ lines, logs })).not.toMatch(
      /private-parameter-value|private-browserbase-key/,
    );
    await service.shutdown();
  });

  it("logs privacy-safe direct-run step transitions", async () => {
    const run = vi.fn(async (input: BrowserbaseRunInput) => {
      const stepId = "private-step-id";
      input.onEvent?.({ type: "worker.started" });
      input.onEvent?.({ type: "step.started", stepId, stepIndex: 2 });
      input.onEvent?.({ type: "step.phase", stepId, stepIndex: 2, phase: "acting" });
      input.onEvent?.({
        type: "step.skipped",
        stepId,
        stepIndex: 2,
        reason: "redundant-option-click",
      });
      input.onEvent?.({ type: "step.completed", stepId, stepIndex: 2, durationMs: 7 });
      input.onEvent?.({
        type: "step.failed",
        stepId,
        stepIndex: 2,
        phase: "waiting",
        diagnostic: {
          message: "private-diagnostic-message",
          attempts: [{ kind: "private-locator-kind", reason: "private-attempt-reason" }],
        },
      });
      input.onEvent?.({ type: "step.cancelled", stepId, stepIndex: 2 });
      return completedOutcome;
    });
    const { logs, service } = fixture(run);

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });
    const stepLogs = logs.filter((record) => record.event === "run.step");

    expect(response.statusCode).toBe(200);
    expect(stepLogs).toEqual([
      {
        event: "run.step",
        runId: "11111111-1111-4111-8111-111111111111",
        stepIndex: 2,
        status: "started",
      },
      {
        event: "run.step",
        runId: "11111111-1111-4111-8111-111111111111",
        stepIndex: 2,
        status: "running",
        phase: "acting",
      },
      {
        event: "run.step",
        runId: "11111111-1111-4111-8111-111111111111",
        stepIndex: 2,
        status: "skipped",
        reason: "redundant-option-click",
      },
      {
        event: "run.step",
        runId: "11111111-1111-4111-8111-111111111111",
        stepIndex: 2,
        status: "completed",
        durationMs: 7,
      },
      {
        event: "run.step",
        runId: "11111111-1111-4111-8111-111111111111",
        stepIndex: 2,
        status: "failed",
        phase: "waiting",
      },
      {
        event: "run.step",
        runId: "11111111-1111-4111-8111-111111111111",
        stepIndex: 2,
        status: "cancelled",
      },
    ]);
    expect(JSON.stringify(logs)).not.toMatch(
      /private-step-id|private-diagnostic-message|private-locator-kind|private-attempt-reason/,
    );
    await service.shutdown();
  });

  it("converts an unexpected post-stream exception to a safe terminal outcome", async () => {
    const run = vi.fn(async (input: BrowserbaseRunInput) => {
      input.onEvent?.({ type: "worker.started" });
      throw new Error("raw-error-secret https://private.example private-session-id");
    });
    const { logs, service } = fixture(run);

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });
    const lines = response.body.trim().split("\n").map((line) => JSON.parse(line));

    expect(lines.at(-1)).toMatchObject({
      type: "worker.outcome",
      status: "failed",
      stage: "execution",
      code: "automation_failed",
    });
    expect(lines.filter((line) => line.type === "worker.outcome")).toHaveLength(1);
    expect(JSON.stringify({ lines, logs })).not.toMatch(
      /raw-error-secret|private\.example|private-session-id|private-parameter-value/,
    );
    await service.shutdown();
  });

  it("does not let a safe-log transport failure replace the run outcome", async () => {
    const createWorker = vi.fn(() => ({
      run: async (input: BrowserbaseRunInput) => {
        input.onEvent?.({ type: "worker.started" });
        input.onEvent?.({ type: "step.started", stepId: "private-step-id", stepIndex: 0 });
        return completedOutcome;
      },
    })) as unknown as (workerConfig: BrowserbaseWorkerConfig) => BrowserbaseAutomationWorker;
    const service = buildAutomationService(config, {
      createWorker,
      log: () => {
        throw new Error("private-log-transport-error");
      },
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      registerInngest: vi.fn(),
    });

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });
    const terminal = response.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);

    expect(terminal).toMatchObject({ type: "worker.outcome", status: "completed" });
    await service.shutdown();
  });

  it.each([
    {
      status: "failed" as const,
      stage: "provisioning" as const,
      code: "browserbase_unavailable" as const,
      cleanupStatus: "not_started" as const,
    },
    {
      status: "timed_out" as const,
      stage: "execution" as const,
      cleanupStatus: "completed" as const,
    },
    {
      status: "cancelled" as const,
      stage: "execution" as const,
      cleanupStatus: "completed" as const,
    },
  ])("keeps the HTTP stream successful for a terminal $status outcome", async (outcome) => {
    const { service } = fixture(async (input) => {
      input.onEvent?.({ type: "worker.started" });
      return outcome;
    });

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });
    const terminal = response.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);

    expect(response.statusCode).toBe(200);
    expect(terminal).toMatchObject({ type: "worker.outcome", ...outcome });
    await service.shutdown();
  });

  it("emits safe heartbeats while a streamed run is idle", async () => {
    vi.useFakeTimers();
    let finish!: (outcome: BrowserbaseRunOutcome) => void;
    const run = vi.fn(
      (input: BrowserbaseRunInput) =>
        new Promise<BrowserbaseRunOutcome>((resolve) => {
          finish = resolve;
          input.onEvent?.({ type: "worker.started" });
        }),
    );
    const { service } = fixture(run);

    const responsePromise = service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    finish(completedOutcome);
    await vi.advanceTimersByTimeAsync(0);
    const response = await responsePromise;
    const lines = response.body.trim().split("\n").map((line) => JSON.parse(line));

    expect(lines.map((line) => line.type)).toEqual([
      "worker.started",
      "heartbeat",
      "worker.outcome",
    ]);
    await service.shutdown();
  });

  it("returns 429 instead of keeping an in-memory queue", async () => {
    let finish!: (outcome: BrowserbaseRunOutcome) => void;
    const run = vi.fn(
      (input: BrowserbaseRunInput) =>
        new Promise<BrowserbaseRunOutcome>((resolve) => {
          finish = resolve;
          input.onEvent?.({ type: "worker.started" });
        }),
    );
    const { service } = fixture(run);
    const first = service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const second = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });
    const readiness = await service.app.inject({ method: "GET", url: "/health/ready" });

    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("2");
    expect(second.json()).toMatchObject({ error: { code: "at_capacity" } });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toEqual({ status: "ok" });
    finish(completedOutcome);
    await first;
    await service.shutdown();
  });

  it("creates a batch and polls privacy-safe progress without a GET content type", async () => {
    let finish!: (outcome: BrowserbaseRunOutcome) => void;
    const run = vi.fn(
      (input: BrowserbaseRunInput) =>
        new Promise<BrowserbaseRunOutcome>((resolve) => {
          finish = resolve;
          input.onEvent?.({ type: "worker.started" });
          input.onEvent?.({ type: "run.started", totalSteps: 2 });
          input.onEvent?.({
            type: "step.skipped",
            stepId: "private-step-id",
            stepIndex: 0,
            reason: "disabled",
          });
        }),
    );
    const { service } = fixture(run, { maxConcurrentRuns: 5 });

    const created = await service.app.inject({
      method: "POST",
      url: "/v1/batches",
      headers: batchHeaders(),
      payload: { runs: [{ workflow: batchWorkflow(1) }] },
    });
    const batchId = created.json().batchId as string;
    const progress = await service.app.inject({
      method: "GET",
      url: `/v1/batches/${batchId}`,
      headers: {
        accept: "application/json",
      },
    });

    expect(created.statusCode).toBe(202);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.json()).toEqual({
      batchId: "11111111-1111-4111-8111-111111111111",
      runCount: 1,
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.headers["cache-control"]).toBe("no-store");
    expect(progress.json()).toEqual({
      batchId,
      runs: [
        {
          workflowId: batchWorkflow(1).id,
          status: "running",
          currentStep: 1,
          totalSteps: 2,
        },
      ],
    });
    expect(progress.body).not.toMatch(/private-workflow|private-1\.example|private-step-id/);

    finish(completedOutcome);
    await vi.waitFor(async () => {
      const terminal = await service.app.inject({
        method: "GET",
        url: `/v1/batches/${batchId}`,
        headers: {
          accept: "application/json",
        },
      });
      expect(terminal.json().runs[0].status).toBe("completed");
    });
    await service.shutdown();
  });

  it("shares five global slots across batch, direct, and Inngest runs", async () => {
    const finishes: Array<(outcome: BrowserbaseRunOutcome) => void> = [];
    let inngestExecute!: InngestRunExecutor;
    const run = vi.fn(
      (input: BrowserbaseRunInput) =>
        new Promise<BrowserbaseRunOutcome>((resolve) => {
          finishes.push(resolve);
          input.onEvent?.({ type: "worker.started" });
        }),
    );
    const service = buildAutomationService(
      { ...config, inngestDev: true, maxConcurrentRuns: 5 },
      {
        createWorker: vi.fn(() => ({ run })) as unknown as (
          workerConfig: BrowserbaseWorkerConfig,
        ) => BrowserbaseAutomationWorker,
        log: vi.fn(),
        randomUUID: () => "44444444-4444-4444-8444-444444444444",
        registerInngest: vi.fn((_app, execute: InngestRunExecutor) => {
          inngestExecute = execute;
        }),
      },
    );

    const created = await service.app.inject({
      method: "POST",
      url: "/v1/batches",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      payload: {
        runs: Array.from({ length: 6 }, (_, index) => ({ workflow: batchWorkflow(index + 1) })),
      },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5));

    const direct = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: runHeaders(),
      payload: requestBody,
    });
    const inngest = await inngestExecute({ workflow: batchWorkflow(10) });

    expect(created.statusCode).toBe(202);
    expect(direct.statusCode).toBe(429);
    expect(inngest).toEqual({ accepted: false, code: "at_capacity" });

    finishes[0]!(completedOutcome);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(6));
    for (const finish of finishes.slice(1)) finish(completedOutcome);
    await vi.waitFor(async () => {
      const snapshot = await service.app.inject({
        method: "GET",
        url: `/v1/batches/${created.json().batchId}`,
        headers: {
          accept: "application/json",
        },
      });
      expect(snapshot.json().runs.every((item: { status: string }) => item.status === "completed"))
        .toBe(true);
    });
    await service.shutdown();
  });

  it("accepts unauthenticated batches and rejects malformed or unknown requests safely", async () => {
    const { service } = fixture(undefined, { maxConcurrentRuns: 5 });
    const withoutAuthorization = await service.app.inject({
      method: "POST",
      url: "/v1/batches",
      headers: { accept: "application/json", "content-type": "application/json" },
      payload: { runs: [{ workflow: batchWorkflow(1) }] },
    });
    const malformed = await service.app.inject({
      method: "POST",
      url: "/v1/batches",
      headers: batchHeaders(),
      payload: {
        runs: [{ workflow: { ...batchWorkflow(1), schemaVersion: undefined } }],
      },
    });
    const empty = await service.app.inject({
      method: "POST",
      url: "/v1/batches",
      headers: batchHeaders(),
      payload: { runs: [] },
    });
    const tooMany = await service.app.inject({
      method: "POST",
      url: "/v1/batches",
      headers: batchHeaders(),
      payload: {
        runs: Array.from({ length: 11 }, (_, index) => ({ workflow: batchWorkflow(index + 1) })),
      },
    });
    const notAcceptable = await service.app.inject({
      method: "POST",
      url: "/v1/batches",
      headers: { ...batchHeaders(), accept: "application/x-ndjson" },
      payload: { runs: [{ workflow: batchWorkflow(1) }] },
    });
    const unknown = await service.app.inject({
      method: "GET",
      url: "/v1/batches/99999999-9999-4999-8999-999999999999",
      headers: {
        accept: "application/json",
      },
    });

    expect(withoutAuthorization.statusCode).toBe(202);
    expect(malformed.statusCode).toBe(400);
    expect(empty.statusCode).toBe(400);
    expect(tooMany.statusCode).toBe(400);
    expect(notAcceptable.statusCode).toBe(406);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({
      error: { code: "batch_not_found", message: "The batch is unknown or expired." },
    });
    await service.shutdown();
  });
});
