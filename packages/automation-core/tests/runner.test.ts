import { afterEach, describe, expect, it, vi } from "vitest";
import type { Frame, Locator, Page } from "playwright-core";
import {
  AutomationRunner,
  preflightAutomation,
  type AutomationEvent,
  type WorkflowStep,
} from "../src/index.js";
import { clickStep, navigateStep, workflowWith } from "./fixtures.js";

function runnerPage(failingName?: string) {
  const calls: string[] = [];
  const locatorFor = (name: string): Locator =>
    ({
      click: vi.fn(async () => {
        calls.push(`click:${name}`);
        if (name === failingName) throw new Error("private browser failure");
      }),
      count: vi.fn(async () => 1),
      innerText: vi.fn(async () => "Ready for review"),
      isVisible: vi.fn(async () => true),
      selectOption: vi.fn(async () => {
        calls.push(`select:${name}`);
        return ["selected"];
      }),
    }) as unknown as Locator;
  const frame = {
    getByRole: vi.fn((_role: string, options?: { name?: string | RegExp }) =>
      locatorFor(String(options?.name ?? "unnamed")),
    ),
    url: vi.fn(() => "https://example.com/start"),
  } as unknown as Frame;
  const page = {
    frames: vi.fn(() => [frame]),
    goto: vi.fn(async (url: string) => {
      calls.push(`goto:${url}`);
      return null;
    }),
    mainFrame: vi.fn(() => frame),
  } as unknown as Page;
  return { calls, page };
}

function namedClick(
  id: string,
  name: string,
  order: number,
): Extract<WorkflowStep, { type: "click" }> {
  return {
    ...clickStep(order),
    id,
    name,
    target: { candidates: [{ kind: "role", value: "button", name, exact: true }] },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AutomationRunner", () => {
  it("uses the default step timeout for browser actions", async () => {
    const { page } = runnerPage();

    await new AutomationRunner(page).run(preflightAutomation(workflowWith([navigateStep()])));

    expect(page.goto).toHaveBeenCalledWith("https://example.com/form", {
      timeout: 15_000,
      waitUntil: "domcontentloaded",
    });
  });

  it("uses a configured step timeout for browser actions", async () => {
    const { page } = runnerPage();

    await new AutomationRunner(page, { stepTimeoutMs: 60_000 }).run(
      preflightAutomation(workflowWith([navigateStep()])),
    );

    expect(page.goto).toHaveBeenCalledWith("https://example.com/form", {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    });
  });

  it("runs in workflow array order and skips disabled and redundant steps", async () => {
    const first = namedClick("first", "First", 50);
    const disabled = { ...namedClick("disabled", "Disabled", 0), enabled: false };
    const redundant: WorkflowStep = {
      ...namedClick("option-click", "Illinois", 10),
      target: {
        tagName: "option",
        candidates: [{ kind: "role", value: "option", name: "Illinois", exact: true }],
      },
    };
    const select: WorkflowStep = {
      ...namedClick("select-state", "State", 5),
      type: "select",
      payload: { value: "IL", label: "Illinois" },
    };
    const { calls, page } = runnerPage();
    const events: AutomationEvent[] = [];

    const result = await new AutomationRunner(page, { onEvent: (event) => events.push(event) }).run(
      preflightAutomation(workflowWith([first, disabled, redundant, select])),
    );

    expect(calls).toEqual([
      "goto:https://example.com/start",
      "click:First",
      "select:State",
    ]);
    expect(result).toMatchObject({
      status: "completed",
      totalSteps: 4,
      passedSteps: 2,
      skippedSteps: 2,
    });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "step.started",
      "step.phase",
      "step.phase",
      "step.completed",
      "step.skipped",
      "step.skipped",
      "step.started",
      "step.phase",
      "step.phase",
      "step.completed",
      "run.completed",
    ]);
  });

  it("stops on the first failed step and returns safe structured diagnostics", async () => {
    const { calls, page } = runnerPage("First");
    const events: AutomationEvent[] = [];
    const workflow = workflowWith([
      namedClick("first", "First", 0),
      namedClick("second", "Second", 1),
    ]);
    workflow.source.startUrl = "https://private.example.test/start?token=secret";
    workflow.source.sessionId = "private-session";

    const result = await new AutomationRunner(page, { onEvent: (event) => events.push(event) }).run(
      preflightAutomation(workflow),
    );

    expect(calls).not.toContain("click:Second");
    expect(result).toMatchObject({
      status: "failed",
      failedStepId: "first",
      failedStepIndex: 0,
      phase: "acting",
      diagnostic: { message: "The automation action could not be completed." },
    });
    expect(events.at(-1)?.type).toBe("run.failed");
    expect(JSON.stringify({ result, events })).not.toMatch(
      /private browser failure|private\.example|token=secret|private-session/,
    );
  });

  it("reports assertions with the asserting phase and does not settle afterward", async () => {
    const { page } = runnerPage();
    const events: AutomationEvent[] = [];
    const { waitAfter: _waitAfter, ...assertionBase } = clickStep();
    const assertion: WorkflowStep = {
      ...assertionBase,
      type: "assertion",
      expectation: { kind: "text_contains", expected: "ready" },
    };

    const result = await new AutomationRunner(page, {
      onEvent: (event) => events.push(event),
    }).run(preflightAutomation(workflowWith([assertion])));

    expect(result).toMatchObject({ status: "completed", passedSteps: 1 });
    expect(
      events.filter((event) => event.type === "step.phase").map((event) => event.phase),
    ).toEqual(["asserting"]);
  });

  it("returns a cancelled result instead of throwing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, page } = runnerPage();
    const events: AutomationEvent[] = [];

    const result = await new AutomationRunner(page, {
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    }).run(preflightAutomation(workflowWith([namedClick("first", "First", 0)])));

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      status: "cancelled",
      totalSteps: 1,
      passedSteps: 0,
      skippedSteps: 0,
    });
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.cancelled"]);
  });

  it("reports the current step when cancellation happens during execution", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { page } = runnerPage();
    const events: AutomationEvent[] = [];
    const waitingStep = { ...namedClick("waiting", "Waiting", 0), waitAfter: { delayMs: 30_000 } };
    const running = new AutomationRunner(page, {
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    }).run(preflightAutomation(workflowWith([waitingStep])));

    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);
    const result = await running;

    expect(result).toMatchObject({
      status: "cancelled",
      currentStepId: "waiting",
      currentStepIndex: 0,
    });
    expect(events.slice(-2).map((event) => event.type)).toEqual([
      "step.cancelled",
      "run.cancelled",
    ]);
  });

  it("starts from the selected workflow index", async () => {
    const { calls, page } = runnerPage();
    const workflow = workflowWith([
      namedClick("before", "Before", 0),
      namedClick("selected", "Selected", 1),
    ]);

    const result = await new AutomationRunner(page).run(
      preflightAutomation(workflow, "selected"),
    );

    expect(calls).toEqual([
      "goto:https://example.com/start",
      "click:Selected",
    ]);
    expect(result).toMatchObject({ status: "completed", totalSteps: 1, passedSteps: 1 });
  });
});
