import type {
  BrowserbaseAutomationWorker,
  BrowserbaseRunInput,
  BrowserbaseRunOutcome,
  BrowserbaseWorkerConfig,
} from "@relay/automation-worker-browserbase";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAutomationService } from "../src/app.js";
import type { AutomationServiceConfig } from "../src/config.js";
import type { InngestRunExecutor } from "../src/inngest.js";

const serviceToken = "service-token-that-is-at-least-32-bytes";
const config: AutomationServiceConfig = {
  host: "127.0.0.1",
  inngestDev: false,
  port: 8080,
  maxConcurrentRuns: 1,
  retryAfterSeconds: 1,
  shutdownGraceMs: 1_000,
  serviceToken,
  worker: { apiKey: "browserbase-key" },
};

const cancelledOutcome: BrowserbaseRunOutcome = {
  status: "cancelled",
  stage: "execution",
  cleanupStatus: "completed",
};

function serviceWith(run: (input: BrowserbaseRunInput) => Promise<BrowserbaseRunOutcome>) {
  return buildAutomationService(config, {
    createWorker: vi.fn((_workerConfig: BrowserbaseWorkerConfig) => ({ run })) as unknown as (
      workerConfig: BrowserbaseWorkerConfig,
    ) => BrowserbaseAutomationWorker,
    log: vi.fn(),
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    registerInngest: vi.fn(),
  });
}

function headers() {
  return {
    accept: "application/x-ndjson",
    authorization: `Bearer ${serviceToken}`,
    "content-type": "application/json",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("automation service lifecycle", () => {
  it("aborts an active Inngest worker during shutdown", async () => {
    let inngestExecute!: InngestRunExecutor;
    let observedSignal: AbortSignal | undefined;
    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const run = vi.fn(
      (input: BrowserbaseRunInput) =>
        new Promise<BrowserbaseRunOutcome>((resolve) => {
          observedSignal = input.signal;
          markRunStarted();
          input.signal?.addEventListener("abort", () => resolve(cancelledOutcome), { once: true });
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
    const inngestRun = inngestExecute({ workflow: { schemaVersion: "1.2" } });
    await runStarted;

    const shutdown = service.shutdown();

    expect(observedSignal?.aborted).toBe(true);
    await expect(inngestRun).resolves.toEqual({ accepted: true, outcome: cancelledOutcome });
    await shutdown;
  });

  it("cancels an active run when the streaming client disconnects", async () => {
    let cancellationObserved!: () => void;
    const wasCancelled = new Promise<void>((resolve) => {
      cancellationObserved = resolve;
    });
    const run = vi.fn(
      (input: BrowserbaseRunInput) =>
        new Promise<BrowserbaseRunOutcome>((resolve) => {
          input.onEvent?.({ type: "worker.started" });
          input.signal?.addEventListener(
            "abort",
            () => {
              cancellationObserved();
              resolve(cancelledOutcome);
            },
            { once: true },
          );
        }),
    );
    const service = serviceWith(run);
    await service.app.listen({ host: "127.0.0.1", port: 0 });
    const address = service.app.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind.");
    const requestController = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/run`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow: { schemaVersion: "1.2" } }),
      signal: requestController.signal,
    });
    expect(response.status).toBe(200);
    await response.body?.getReader().read();

    requestController.abort();

    await expect(wasCancelled).resolves.toBeUndefined();
    await service.shutdown();
  });

  it("marks readiness unavailable and aborts active runs during shutdown", async () => {
    let finish!: (outcome: BrowserbaseRunOutcome) => void;
    let observedSignal: AbortSignal | undefined;
    let runStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const run = vi.fn(
      (input: BrowserbaseRunInput) =>
        new Promise<BrowserbaseRunOutcome>((resolve) => {
          finish = resolve;
          observedSignal = input.signal;
          input.onEvent?.({ type: "worker.started" });
          runStarted();
        }),
    );
    const service = serviceWith(run);
    const activeRequest = service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: headers(),
      payload: { workflow: { schemaVersion: "1.2" } },
    });
    await started;

    const shutdown = service.shutdown();
    const readiness = await service.app.inject({ method: "GET", url: "/health/ready" });

    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({ status: "shutting_down" });
    expect(observedSignal?.aborted).toBe(true);
    finish(cancelledOutcome);
    await activeRequest;
    await shutdown;
  });

  it("stops waiting after the shutdown grace when a worker ignores cancellation", async () => {
    let finish!: (outcome: BrowserbaseRunOutcome) => void;
    const run = vi.fn(
      (input: BrowserbaseRunInput) =>
        new Promise<BrowserbaseRunOutcome>((resolve) => {
          finish = resolve;
          input.onEvent?.({ type: "worker.started" });
        }),
    );
    const service = buildAutomationService(
      { ...config, shutdownGraceMs: 10 },
      {
        createWorker: vi.fn(() => ({ run })) as unknown as (
          workerConfig: BrowserbaseWorkerConfig,
        ) => BrowserbaseAutomationWorker,
        log: vi.fn(),
        randomUUID: () => "11111111-1111-4111-8111-111111111111",
        registerInngest: vi.fn(),
      },
    );
    await service.app.listen({ host: "127.0.0.1", port: 0 });
    const address = service.app.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind.");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/run`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ workflow: { schemaVersion: "1.2" } }),
    });
    expect(response.status).toBe(200);
    await response.body?.getReader().read();

    await expect(service.shutdown()).resolves.toBeUndefined();
    finish(cancelledOutcome);
  });
});
