import type {
  BrowserbaseAutomationWorker,
  BrowserbaseRunInput,
  BrowserbaseRunOutcome,
  BrowserbaseWorkerConfig,
} from "@relay/automation-worker-browserbase";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAutomationService, type SafeLogRecord } from "../src/app.js";
import type { AutomationServiceConfig } from "../src/config.js";

const config: AutomationServiceConfig = {
  host: "127.0.0.1",
  port: 8080,
  maxConcurrentRuns: 1,
  retryAfterSeconds: 2,
  shutdownGraceMs: 30_000,
  serviceToken: "service-token-that-is-at-least-32-bytes",
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
  workflow: { schemaVersion: "1.2", status: "complete" },
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
  const service = buildAutomationService(
    { ...config, ...overrides },
    {
      createWorker,
      log: (record) => logs.push(record),
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    },
  );
  return { createWorker, logs, run, service };
}

function authorizedHeaders(accept = "application/x-ndjson") {
  return {
    accept,
    authorization: `Bearer ${config.serviceToken}`,
    "content-type": "application/json",
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("automation service contract", () => {
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
    [{}, 401, "unauthorized"],
    [{ authorization: "Bearer wrong-token", accept: "application/x-ndjson" }, 401, "unauthorized"],
    [{ authorization: `Bearer ${config.serviceToken}`, accept: "application/json" }, 406, "not_acceptable"],
    [
      {
        authorization: `Bearer ${config.serviceToken}`,
        accept: "application/x-ndjson;q=0",
      },
      406,
      "not_acceptable",
    ],
  ])("rejects unauthorized or incompatible callers", async (headers, statusCode, code) => {
    const { service } = fixture();
    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers,
      payload: requestBody,
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ error: { code } });
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
        authorization: `Bearer ${config.serviceToken}`,
        "content-type": "text/plain",
      },
      payload: "private-body",
    });
    const extraField = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: authorizedHeaders(),
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
      headers: authorizedHeaders(),
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
      headers: authorizedHeaders(),
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
      headers: authorizedHeaders(),
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

  it("converts an unexpected post-stream exception to a safe terminal outcome", async () => {
    const run = vi.fn(async (input: BrowserbaseRunInput) => {
      input.onEvent?.({ type: "worker.started" });
      throw new Error("raw-error-secret https://private.example private-session-id");
    });
    const { logs, service } = fixture(run);

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: authorizedHeaders(),
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
        return completedOutcome;
      },
    })) as unknown as (workerConfig: BrowserbaseWorkerConfig) => BrowserbaseAutomationWorker;
    const service = buildAutomationService(config, {
      createWorker,
      log: () => {
        throw new Error("private-log-transport-error");
      },
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    });

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: authorizedHeaders(),
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
      headers: authorizedHeaders(),
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
      headers: authorizedHeaders(),
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
      headers: authorizedHeaders(),
      payload: requestBody,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const second = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: authorizedHeaders(),
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
});
