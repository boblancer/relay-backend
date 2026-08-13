import { describe, expect, it, vi } from "vitest";
import type {
  BrowserbaseAutomationWorker,
  BrowserbaseRunInput,
  BrowserbaseRunOutcome,
  BrowserbaseWorkerConfig,
} from "../src/index.js";
import { runCli, type CliDependencies } from "../src/cli.js";
import { completeWorkflow, navigateStep } from "./fixtures.js";

function cliFixture(files: Record<string, string>, outcome?: BrowserbaseRunOutcome) {
  const writes: string[] = [];
  const run = vi.fn(async (_input: BrowserbaseRunInput) =>
    outcome ?? {
      status: "completed" as const,
      stage: "execution" as const,
      result: {
        status: "completed" as const,
        totalSteps: 1,
        passedSteps: 1,
        skippedSteps: 0,
        durationMs: 10,
      },
      cleanupStatus: "completed" as const,
    },
  );
  const createWorker = vi.fn((_config: BrowserbaseWorkerConfig) => ({ run })) as unknown as (
    config: BrowserbaseWorkerConfig,
  ) => BrowserbaseAutomationWorker;
  const dependencies: CliDependencies = {
    readFile: vi.fn(async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error("private file system detail");
      return Buffer.from(content);
    }),
    write: (line) => writes.push(line),
    createWorker,
  };
  return { createWorker, dependencies, run, writes };
}

describe("runCli", () => {
  it("validates a canonical complete workflow without Browserbase credentials", async () => {
    const workflow = JSON.stringify(completeWorkflow([navigateStep()]));
    const fixture = cliFixture({ "/private/workflow.json": workflow });

    const exitCode = await runCli(
      ["validate", "--workflow", "/private/workflow.json"],
      {},
      fixture.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(fixture.createWorker).not.toHaveBeenCalled();
    expect(fixture.writes.map((line) => JSON.parse(line))).toEqual([
      { type: "validation.completed", status: "completed", totalSteps: 1 },
    ]);
    expect(fixture.writes.join("\n")).not.toContain("/private/workflow.json");
  });

  it("validates workflows with older schema labels", async () => {
    const workflow = JSON.stringify({
      ...completeWorkflow([navigateStep()]),
      schemaVersion: "1.2",
    });
    const fixture = cliFixture({ "/private/workflow.json": workflow });

    await expect(
      runCli(
        ["validate", "--workflow", "/private/workflow.json"],
        {},
        fixture.dependencies,
      ),
    ).resolves.toBe(0);
    expect(fixture.writes.map((line) => JSON.parse(line))).toEqual([
      { type: "validation.completed", status: "completed", totalSteps: 1 },
    ]);
  });

  it("returns a safe validation failure for unreadable files", async () => {
    const missingFixture = cliFixture({});
    await expect(
      runCli(
        ["validate", "--workflow", "/private/missing.json"],
        {},
        missingFixture.dependencies,
      ),
    ).resolves.toBe(2);
    expect(missingFixture.writes.join("\n")).not.toMatch(/private|file system detail/);
  });

  it("passes strict environment configuration and secret parameters to the worker", async () => {
    const workflow = JSON.stringify(completeWorkflow([navigateStep()]));
    const parameters = JSON.stringify({ runtime: "parameter-secret" });
    const fixture = cliFixture({
      "/private/workflow.json": workflow,
      "/private/parameters.json": parameters,
    });

    const exitCode = await runCli(
      [
        "run",
        "--workflow",
        "/private/workflow.json",
        "--start-step",
        "navigate",
        "--parameters-file",
        "/private/parameters.json",
      ],
      {
        BROWSERBASE_API_KEY: "api-secret",
        BROWSERBASE_PROJECT_ID: "project-id",
        BROWSERBASE_REGION: "eu-central-1",
        BROWSERBASE_USE_PROXY: "true",
        BROWSERBASE_VERIFIED: "true",
      },
      fixture.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(fixture.createWorker).toHaveBeenCalledWith({
      apiKey: "api-secret",
      projectId: "project-id",
      region: "eu-central-1",
      useProxy: true,
      verified: true,
    });
    expect(fixture.run).toHaveBeenCalledWith(
      expect.objectContaining({
        startStepId: "navigate",
        parameterValues: { runtime: "parameter-secret" },
      }),
    );
    expect(fixture.writes.join("\n")).not.toMatch(
      /api-secret|parameter-secret|private|example\.com/,
    );
  });

  it("rejects malformed arguments, parameters, environment, and missing API keys", async () => {
    const workflow = JSON.stringify(completeWorkflow([navigateStep()]));
    const fixture = cliFixture({
      workflow,
      parameters: JSON.stringify(["not-an-object"]),
    });

    await expect(runCli(["run", "--workflow", "workflow"], {}, fixture.dependencies)).resolves.toBe(
      2,
    );
    await expect(
      runCli(
        ["run", "--workflow", "workflow", "--parameters-file", "parameters"],
        { BROWSERBASE_API_KEY: "key" },
        fixture.dependencies,
      ),
    ).resolves.toBe(2);
    await expect(
      runCli(
        ["run", "--workflow", "workflow", "--unknown", "value"],
        { BROWSERBASE_API_KEY: "key" },
        fixture.dependencies,
      ),
    ).resolves.toBe(2);
    await expect(
      runCli(
        ["run", "--workflow", "workflow"],
        { BROWSERBASE_API_KEY: "key", BROWSERBASE_USE_PROXY: "sometimes" },
        fixture.dependencies,
      ),
    ).resolves.toBe(2);
    expect(fixture.createWorker).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "failed", stage: "validation", code: "missing_parameter", cleanupStatus: "not_started" }, 2],
    [{ status: "failed", stage: "execution", code: "automation_failed", cleanupStatus: "completed" }, 1],
    [{ status: "timed_out", stage: "execution", cleanupStatus: "completed" }, 124],
    [{ status: "cancelled", stage: "execution", cleanupStatus: "completed" }, 130],
  ] as const)("maps the %s outcome to exit code %s", async (outcome, expectedExitCode) => {
    const workflow = JSON.stringify(completeWorkflow([navigateStep()]));
    const fixture = cliFixture({ workflow }, outcome as BrowserbaseRunOutcome);

    const exitCode = await runCli(
      ["run", "--workflow", "workflow"],
      { BROWSERBASE_API_KEY: "key" },
      fixture.dependencies,
    );

    expect(exitCode).toBe(expectedExitCode);
    expect(fixture.writes.map((line) => JSON.parse(line)).at(-1)).toMatchObject({
      type: "worker.outcome",
      status: outcome.status,
    });
  });
});
