import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright-core";
import {
  BrowserbaseAutomationWorker,
  type BrowserbaseSessionClient,
  type BrowserbaseWorkerDependencies,
  type BrowserbaseWorkerEvent,
} from "../src/worker.js";
import { assertionStep, completeWorkflow, navigateStep } from "./fixtures.js";

function workerFixture(options: {
  createError?: Error;
  connectError?: Error;
  gotoError?: Error;
  gotoDelayMs?: number;
  closeError?: Error;
  closeThrowsSynchronously?: boolean;
  releaseError?: Error;
  assertionText?: string;
} = {}) {
  const locator = {
    count: vi.fn(async () => 1),
    innerText: vi.fn(async () => options.assertionText ?? "ready"),
    isVisible: vi.fn(async () => true),
  } as unknown as Locator;
  const frame = {
    getByTestId: vi.fn(() => locator),
    url: vi.fn(() => "https://example.com/form"),
  } as unknown as Frame;
  const page = {
    frames: vi.fn(() => [frame]),
    goto: vi.fn(async () => {
      if (options.gotoDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.gotoDelayMs));
      }
      if (options.gotoError) throw options.gotoError;
      return null;
    }),
    mainFrame: vi.fn(() => frame),
    off: vi.fn(),
    on: vi.fn(),
  } as unknown as Page;
  const context = { pages: vi.fn(() => [page]) } as unknown as BrowserContext;
  const close = vi.fn(() => {
    if (options.closeThrowsSynchronously) throw options.closeError;
    return Promise.resolve().then(() => {
      if (options.closeError) throw options.closeError;
    });
  });
  const browser = { contexts: vi.fn(() => [context]), close } as unknown as Browser;
  const create = vi.fn(async () => {
    if (options.createError) throw options.createError;
    return { id: "private-session-id", connectUrl: "wss://private-connect-url" };
  });
  const release = vi.fn(async () => {
    if (options.releaseError) throw options.releaseError;
  });
  const sessionClient: BrowserbaseSessionClient = { create, release };
  const connect = vi.fn(async () => {
    if (options.connectError) throw options.connectError;
    return browser;
  });
  const dependencies: BrowserbaseWorkerDependencies = { sessionClient, connect };
  return { browser, close, connect, create, dependencies, page, release };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserbaseAutomationWorker", () => {
  it("creates a private Browserbase session and runs with the remote timeout", async () => {
    const fixture = workerFixture();
    const events: BrowserbaseWorkerEvent[] = [];
    const worker = new BrowserbaseAutomationWorker(
      {
        apiKey: "api-key",
        projectId: "project-id",
        region: "us-east-1",
        useProxy: true,
        verified: true,
      },
      fixture.dependencies,
    );

    const outcome = await worker.run({
      workflow: completeWorkflow([navigateStep()]),
      onEvent: (event) => events.push(event),
    });

    expect(outcome).toMatchObject({
      status: "completed",
      stage: "execution",
      cleanupStatus: "completed",
      result: { status: "completed", passedSteps: 1 },
    });
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        browserSettings: expect.objectContaining({
          logSession: false,
          recordSession: false,
          solveCaptchas: true,
          verified: true,
          viewport: { height: 900, width: 1440 },
        }),
        keepAlive: false,
        projectId: "project-id",
        proxies: true,
        region: "us-east-1",
        timeout: 660,
      }),
      expect.any(AbortSignal),
    );
    expect(fixture.connect).toHaveBeenCalledWith("wss://private-connect-url", 60_000);
    expect(fixture.page.goto).toHaveBeenCalledWith("https://example.com/form", {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    });
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith("private-session-id");
    expect(events.map((event) => event.type)).toEqual([
      "worker.started",
      "browser.provisioning",
      "browser.connected",
      "run.started",
      "step.started",
      "step.phase",
      "step.phase",
      "step.completed",
      "run.completed",
    ]);
  });

  it("fails validation before creating a paid session", async () => {
    const fixture = workerFixture();
    const workflow = completeWorkflow([navigateStep()]);
    const worker = new BrowserbaseAutomationWorker({ apiKey: "api-key" }, fixture.dependencies);

    const outcome = await worker.run({ workflow: { ...workflow, status: "draft" } });

    expect(outcome).toEqual({
      status: "failed",
      stage: "validation",
      code: "workflow_not_complete",
      cleanupStatus: "not_started",
    });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("rejects schema 1.2 before creating a paid session", async () => {
    const fixture = workerFixture();
    const workflow = completeWorkflow([navigateStep()]);
    const worker = new BrowserbaseAutomationWorker({ apiKey: "api-key" }, fixture.dependencies);

    const outcome = await worker.run({ workflow: { ...workflow, schemaVersion: "1.2" } });

    expect(outcome).toEqual({
      status: "failed",
      stage: "validation",
      code: "invalid_workflow",
      cleanupStatus: "not_started",
    });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("reports assertion failures with a privacy-safe asserting phase", async () => {
    const fixture = workerFixture({ assertionText: "private observed content" });
    const events: BrowserbaseWorkerEvent[] = [];
    const worker = new BrowserbaseAutomationWorker({ apiKey: "api-key" }, fixture.dependencies);

    const outcome = await worker.run({
      workflow: completeWorkflow([assertionStep("private expected content")]),
      onEvent: (event) => events.push(event),
    });

    expect(outcome).toMatchObject({
      status: "failed",
      stage: "execution",
      code: "automation_failed",
      cleanupStatus: "completed",
      result: {
        status: "failed",
        failedStepId: "assertion",
        phase: "asserting",
        diagnostic: { message: "The automation assertion did not pass." },
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "step.phase", phase: "asserting" }),
    );
    expect(JSON.stringify({ events, outcome })).not.toMatch(/private expected|private observed/);
  });

  it("rejects blank Browserbase credentials before creating a paid session", async () => {
    const fixture = workerFixture();
    const worker = new BrowserbaseAutomationWorker({ apiKey: "   " }, fixture.dependencies);

    const outcome = await worker.run({ workflow: completeWorkflow([navigateStep()]) });

    expect(outcome).toEqual({
      status: "failed",
      stage: "validation",
      code: "invalid_configuration",
      cleanupStatus: "not_started",
    });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("returns safe provisioning failures and releases created sessions", async () => {
    const fixture = workerFixture({ connectError: new Error("private connection failure") });
    const worker = new BrowserbaseAutomationWorker({ apiKey: "api-key" }, fixture.dependencies);

    const outcome = await worker.run({ workflow: completeWorkflow([navigateStep()]) });

    expect(outcome).toEqual({
      status: "failed",
      stage: "provisioning",
      code: "browser_unavailable",
      cleanupStatus: "completed",
    });
    expect(fixture.release).toHaveBeenCalledWith("private-session-id");
  });

  it("returns privacy-safe execution failures", async () => {
    const fixture = workerFixture({ gotoError: new Error("payload-secret raw provider error") });
    const events: BrowserbaseWorkerEvent[] = [];
    const worker = new BrowserbaseAutomationWorker({ apiKey: "api-key" }, fixture.dependencies);

    const outcome = await worker.run({
      workflow: completeWorkflow([navigateStep()]),
      onEvent: (event) => events.push(event),
    });

    expect(outcome).toMatchObject({
      status: "failed",
      stage: "execution",
      code: "automation_failed",
      cleanupStatus: "completed",
      result: { status: "failed" },
    });
    expect(JSON.stringify({ events, outcome })).not.toMatch(
      /payload-secret|private connection|private-session-id|private-connect-url|example\.com/,
    );
  });

  it("classifies the run deadline separately from caller cancellation", async () => {
    vi.useFakeTimers();
    const timedFixture = workerFixture({ gotoDelayMs: 100 });
    const timedWorker = new BrowserbaseAutomationWorker(
      { apiKey: "api-key", runTimeoutMs: 10 },
      timedFixture.dependencies,
    );
    const timedRun = timedWorker.run({ workflow: completeWorkflow([navigateStep()]) });
    await vi.advanceTimersByTimeAsync(110);

    await expect(timedRun).resolves.toMatchObject({ status: "timed_out", stage: "execution" });

    const cancelledFixture = workerFixture({ gotoDelayMs: 100 });
    const cancelledWorker = new BrowserbaseAutomationWorker(
      { apiKey: "api-key" },
      cancelledFixture.dependencies,
    );
    const controller = new AbortController();
    const cancelledRun = cancelledWorker.run({
      workflow: completeWorkflow([navigateStep()]),
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelledFixture.page.goto).toHaveBeenCalledOnce();
    controller.abort();
    await vi.advanceTimersByTimeAsync(110);

    await expect(cancelledRun).resolves.toMatchObject({ status: "cancelled", stage: "execution" });
  });

  it("reports cleanup failure without replacing a successful result", async () => {
    const fixture = workerFixture({
      closeError: new Error("private close error"),
      releaseError: new Error("private release error"),
    });
    const worker = new BrowserbaseAutomationWorker({ apiKey: "api-key" }, fixture.dependencies);

    const outcome = await worker.run({ workflow: completeWorkflow([navigateStep()]) });

    expect(outcome).toMatchObject({
      status: "completed",
      cleanupStatus: "incomplete",
      result: { status: "completed" },
    });
  });

  it("attempts session release when browser close throws synchronously", async () => {
    const fixture = workerFixture({
      closeError: new Error("private synchronous close error"),
      closeThrowsSynchronously: true,
    });
    const worker = new BrowserbaseAutomationWorker({ apiKey: "api-key" }, fixture.dependencies);

    const outcome = await worker.run({ workflow: completeWorkflow([navigateStep()]) });

    expect(outcome).toMatchObject({ status: "completed", cleanupStatus: "incomplete" });
    expect(fixture.release).toHaveBeenCalledWith("private-session-id");
  });
});
