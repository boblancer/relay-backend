import { afterEach, describe, expect, it, vi } from "vitest";
import type { Frame, Locator, Page, Request } from "playwright-core";
import type { WorkflowStep } from "../src/index.js";
import {
  AutomationCancelledError,
  AutomationExecutionError,
  AutomationExecutor,
} from "../src/execution.js";

const step = (waitAfter?: WorkflowStep["waitAfter"]): WorkflowStep => ({
  id: "step-0",
  order: 0,
  name: "Click continue",
  enabled: true,
  page: { id: "page", url: "https://example.com/form" },
  target: { candidates: [{ kind: "testId", value: "target", exact: true }] },
  waitAfter,
  metadata: {
    recordedAt: "2026-07-31T12:00:00Z",
    origin: "recorded",
    sensitive: false,
  },
  type: "click",
});

function executorPage() {
  const locator = {
    click: vi.fn(async () => undefined),
    count: vi.fn(async () => 1),
    isVisible: vi.fn(async () => true),
  } as unknown as Locator;
  const frame = {
    getByTestId: vi.fn(() => locator),
    url: vi.fn(() => "https://example.com/form"),
  } as unknown as Frame;
  const page = {
    frames: vi.fn(() => [frame]),
    mainFrame: vi.fn(() => frame),
  } as unknown as Page;
  return { locator, page };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AutomationExecutor waits", () => {
  it("honors an explicit post-action delay", async () => {
    vi.useFakeTimers();
    const { locator, page } = executorPage();
    const phases: string[] = [];
    const executor = new AutomationExecutor(page);

    const running = executor.runStep(step({ delayMs: 500 }), (phase) => phases.push(phase));
    await vi.advanceTimersByTimeAsync(499);
    let completed = false;
    void running.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(phases).toEqual(["acting", "settling", "waiting"]);
  });

  it("requires a wait condition to remain satisfied for 300 milliseconds", async () => {
    vi.useFakeTimers();
    const { locator, page } = executorPage();
    const executor = new AutomationExecutor(page);
    const running = executor.runStep(
      step({
        condition: {
          state: "visible",
          target: { candidates: [{ kind: "testId", value: "ready", exact: true }] },
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(299);
    let completed = false;
    void running.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(51);
    await running;
  });

  it("treats a condition as hidden only when no candidate is visible", async () => {
    vi.useFakeTimers();
    const { locator, page } = executorPage();
    const hidden = {
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => false),
    } as unknown as Locator;
    vi.mocked(page.mainFrame().getByTestId).mockImplementation((value) =>
      value === "dialog" ? hidden : locator,
    );
    const executor = new AutomationExecutor(page);
    const running = executor.runStep(
      step({
        condition: {
          state: "hidden",
          target: { candidates: [{ kind: "testId", value: "dialog", exact: true }] },
        },
      }),
    );

    await vi.runAllTimersAsync();
    await running;
  });

  it("cancels promptly during an explicit wait", async () => {
    vi.useFakeTimers();
    const { page } = executorPage();
    const controller = new AbortController();
    const executor = new AutomationExecutor(page, controller.signal);
    const running = executor.runStep(step({ delayMs: 30_000 }));
    const cancelled = expect(running).rejects.toBeInstanceOf(AutomationCancelledError);
    await vi.advanceTimersByTimeAsync(100);

    controller.abort();
    await vi.advanceTimersByTimeAsync(50);

    await cancelled;
  });

  it("waits for tracked requests to be quiet before completing a step", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, Set<(request: Request) => void>>();
    const emit = (event: string, request: Request) =>
      listeners.get(event)?.forEach((listener) => listener(request));
    const request = { resourceType: () => "xhr" } as unknown as Request;
    const locator = {
      click: vi.fn(async () => {
        emit("request", request);
        setTimeout(() => emit("requestfinished", request), 100);
      }),
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => true),
    } as unknown as Locator;
    const frame = {
      getByTestId: vi.fn(() => locator),
      url: vi.fn(() => "https://example.com/form"),
    } as unknown as Frame;
    const page = {
      evaluate: vi.fn(async (_callback: unknown, quietMs?: number) => quietMs === 200),
      frames: vi.fn(() => [frame]),
      mainFrame: vi.fn(() => frame),
      off: vi.fn((event: string, listener: (request: Request) => void) =>
        listeners.get(event)?.delete(listener),
      ),
      on: vi.fn((event: string, listener: (request: Request) => void) => {
        const entries = listeners.get(event) ?? new Set();
        entries.add(listener);
        listeners.set(event, entries);
      }),
      waitForLoadState: vi.fn(async () => undefined),
    } as unknown as Page;
    const executor = new AutomationExecutor(page);
    const running = executor.runStep(step());

    await vi.advanceTimersByTimeAsync(299);
    let completed = false;
    void running.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await running;
    executor.dispose();
    expect(page.off).toHaveBeenCalled();
  });

  it("waits for DOM mutations to remain quiet before completing a step", async () => {
    vi.useFakeTimers();
    const { page } = executorPage();
    let quietChecks = 0;
    Object.assign(page, {
      evaluate: vi.fn(async (_callback: unknown, quietMs?: number) => {
        if (quietMs === undefined) return undefined;
        quietChecks += 1;
        return quietChecks >= 5;
      }),
      waitForLoadState: vi.fn(async () => undefined),
    });
    const executor = new AutomationExecutor(page);
    const running = executor.runStep(step());

    await vi.advanceTimersByTimeAsync(149);
    let completed = false;
    void running.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(51);
    await running;
    expect(quietChecks).toBe(5);
  });

  it("stops automatic settling after five seconds when the DOM stays active", async () => {
    vi.useFakeTimers();
    const { page } = executorPage();
    Object.assign(page, {
      evaluate: vi.fn(async (_callback: unknown, quietMs?: number) =>
        quietMs === undefined ? undefined : false,
      ),
      waitForLoadState: vi.fn(async () => undefined),
    });
    const executor = new AutomationExecutor(page);
    const running = executor.runStep(step());

    await vi.advanceTimersByTimeAsync(4_999);
    let completed = false;
    void running.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await running;
  });

  it("cancels during automatic settling", async () => {
    vi.useFakeTimers();
    const { page } = executorPage();
    Object.assign(page, {
      evaluate: vi.fn(async (_callback: unknown, quietMs?: number) =>
        quietMs === undefined ? undefined : false,
      ),
      waitForLoadState: vi.fn(async () => undefined),
    });
    const controller = new AbortController();
    const executor = new AutomationExecutor(page, controller.signal);
    const running = executor.runStep(step());
    const cancelled = expect(running).rejects.toBeInstanceOf(AutomationCancelledError);

    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);

    await cancelled;
  });

  it("cancels during condition polling", async () => {
    vi.useFakeTimers();
    const { locator, page } = executorPage();
    vi.mocked(locator.isVisible).mockResolvedValue(false);
    const controller = new AbortController();
    const executor = new AutomationExecutor(page, controller.signal);
    const running = executor.runStep(
      step({
        condition: {
          state: "visible",
          target: { candidates: [{ kind: "testId", value: "private-target", exact: true }] },
        },
      }),
    );
    const cancelled = expect(running).rejects.toBeInstanceOf(AutomationCancelledError);

    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);

    await cancelled;
  });

  it("keeps condition timeout diagnostics free of locator values", async () => {
    vi.useFakeTimers();
    const { locator, page } = executorPage();
    const hidden = {
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => false),
    } as unknown as Locator;
    vi.mocked(page.mainFrame().getByTestId).mockImplementation((value) =>
      value === "private-target" ? hidden : locator,
    );
    const running = new AutomationExecutor(page).runStep(
      step({
        condition: {
          state: "visible",
          target: {
            candidates: [{ kind: "testId", value: "private-target", exact: true }],
          },
        },
      }),
    );
    const failed = running.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(15_000);
    const error = await failed;

    expect(error).toBeInstanceOf(AutomationExecutionError);
    expect(JSON.stringify(error)).not.toContain("private-target");
    expect(error).toMatchObject({ phase: "waiting" });
  });

  it("uses the configured step timeout for condition polling", async () => {
    vi.useFakeTimers();
    const { locator, page } = executorPage();
    vi.mocked(locator.isVisible).mockResolvedValue(false);
    const running = new AutomationExecutor(page, undefined, 60_000).runStep(
      step({
        condition: {
          state: "visible",
          target: { candidates: [{ kind: "testId", value: "ready", exact: true }] },
        },
      }),
    );
    let settled = false;
    void running.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(45_000);
    await expect(running).rejects.toBeInstanceOf(AutomationExecutionError);
  });
});
