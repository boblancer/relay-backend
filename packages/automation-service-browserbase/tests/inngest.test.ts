import type { BrowserbaseRunOutcome } from "@relay/automation-worker-browserbase";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserbaseAutomationFunction,
  registerInngestFunctions,
  runBrowserbaseAutomationEvent,
  type InngestRunExecutor,
  type StepRunner,
} from "../src/inngest.js";

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

function immediateStep() {
  const spy = vi.fn(async (_id: string, callback: Parameters<StepRunner>[1]) => callback());
  return { run: spy, spy };
}

describe("minimal Inngest automation function", () => {
  it("registers the SDK endpoint on the existing Fastify listener", async () => {
    const app = Fastify({ logger: false });
    registerInngestFunctions(app, vi.fn());

    const response = await app.inject({ method: "GET", url: "/api/inngest" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ function_count: 1, mode: "dev" });
    expect(response.body).not.toContain("private");
    await app.close();
  });

  it("registers one event trigger with no retries and concurrency one", () => {
    const execute: InngestRunExecutor = vi.fn();
    const fn = createBrowserbaseAutomationFunction(execute);

    expect(fn.opts).toMatchObject({
      id: "browserbase-automation-run",
      retries: 0,
      concurrency: 1,
      triggers: [{ event: "relay/automation.run.requested" }],
    });
  });

  it("runs one durable step and returns only the safe worker outcome", async () => {
    const execute = vi.fn<InngestRunExecutor>(async () => ({
      accepted: true,
      outcome: completedOutcome,
    }));
    const step = immediateStep();
    const eventData = {
      workflow: { schemaVersion: "1.3", privateUrl: "https://private.example" },
      startStepId: "start-step",
      parameterValues: { fill: "private-value" },
    };

    const outcome = await runBrowserbaseAutomationEvent(eventData, step.run, execute);

    expect(step.spy).toHaveBeenCalledOnce();
    expect(step.spy.mock.calls[0]?.[0]).toBe("execute-browserbase-workflow");
    expect(execute).toHaveBeenCalledWith(eventData);
    expect(outcome).toEqual({
      status: "completed",
      stage: "execution",
      cleanupStatus: "completed",
    });
    expect(JSON.stringify(outcome)).not.toMatch(/private|https:/);
  });

  it.each([
    null,
    [],
    {},
    { workflow: [] },
    { workflow: {}, startStepId: "" },
    { workflow: {}, parameterValues: [] },
    { workflow: {}, parameterValues: { fill: 42 } },
    { workflow: {}, unexpected: true },
  ])("rejects malformed event data without calling the worker: %j", async (eventData) => {
    const execute: InngestRunExecutor = vi.fn();

    const outcome = await runBrowserbaseAutomationEvent(eventData, immediateStep().run, execute);

    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "failed",
      stage: "validation",
      code: "invalid_event",
      cleanupStatus: "not_started",
    });
  });

  it.each(["at_capacity", "shutting_down"] as const)(
    "returns a safe %s admission failure",
    async (code) => {
      const execute = vi.fn<InngestRunExecutor>(async () => ({ accepted: false, code }));

      const outcome = await runBrowserbaseAutomationEvent(
        { workflow: { schemaVersion: "1.3" } },
        immediateStep().run,
        execute,
      );

      expect(outcome).toEqual({
        status: "failed",
        stage: "orchestration",
        code,
        cleanupStatus: "not_started",
      });
    },
  );

  it("removes worker result details from safe failures", async () => {
    const failedOutcome: BrowserbaseRunOutcome = {
      status: "failed",
      stage: "execution",
      code: "automation_failed",
      result: {
        status: "failed",
        totalSteps: 1,
        passedSteps: 0,
        skippedSteps: 0,
        durationMs: 10,
        failedStepId: "private-step-id",
        failedStepIndex: 0,
        phase: "acting",
        diagnostic: { message: "private-error", attempts: [] },
      },
      cleanupStatus: "completed",
    };
    const execute = vi.fn<InngestRunExecutor>(async () => ({
      accepted: true,
      outcome: failedOutcome,
    }));

    const outcome = await runBrowserbaseAutomationEvent(
      { workflow: { schemaVersion: "1.3" } },
      immediateStep().run,
      execute,
    );

    expect(outcome).toEqual({
      status: "failed",
      stage: "execution",
      code: "automation_failed",
      cleanupStatus: "completed",
    });
    expect(JSON.stringify(outcome)).not.toMatch(/private/);
  });

  it("maps unexpected local exceptions to a generic safe outcome", async () => {
    const execute: InngestRunExecutor = vi.fn(async () => {
      throw new Error("raw-secret https://private.example session-id");
    });

    const outcome = await runBrowserbaseAutomationEvent(
      { workflow: { schemaVersion: "1.3" } },
      immediateStep().run,
      execute,
    );

    expect(outcome).toEqual({
      status: "failed",
      stage: "execution",
      code: "automation_failed",
      cleanupStatus: "incomplete",
    });
    expect(JSON.stringify(outcome)).not.toMatch(/raw-secret|private|session-id/);
  });
});
