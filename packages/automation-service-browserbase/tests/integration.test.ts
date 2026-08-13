import { BrowserbaseAutomationWorker } from "@relay/automation-worker-browserbase";
import type { Browser, BrowserContext, Frame, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { buildAutomationService } from "../src/app.js";
import type { AutomationServiceConfig } from "../src/config.js";
import { navigationWorkflow } from "./fixtures.js";

const config: AutomationServiceConfig = {
  artifactDirectory: "/tmp/relay-test-artifacts",
  host: "127.0.0.1",
  inngestDev: false,
  port: 8080,
  maxConcurrentRuns: 1,
  retryAfterSeconds: 1,
  screenshotsEnabled: false,
  shutdownGraceMs: 30_000,
  worker: { apiKey: "browserbase-key" },
};

function integrationService() {
  const frame = { url: () => "https://example.com" } as unknown as Frame;
  const page = {
    frames: () => [frame],
    goto: vi.fn(async () => null),
    mainFrame: () => frame,
    off: vi.fn(),
    on: vi.fn(),
  } as unknown as Page;
  const context = { pages: () => [page] } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
    close: vi.fn(async () => undefined),
  } as unknown as Browser;
  const create = vi.fn(async () => ({
    id: "private-provider-session-id",
    connectUrl: "wss://private-provider-connect-url",
  }));
  const release = vi.fn(async () => undefined);
  const service = buildAutomationService(config, {
    createWorker: (workerConfig) =>
      new BrowserbaseAutomationWorker(workerConfig, {
        sessionClient: { create, release },
        connect: vi.fn(async () => browser),
      }),
    log: vi.fn(),
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
    registerInngest: vi.fn(),
  });
  return { create, page, release, service };
}

describe("automation HTTP and worker integration", () => {
  it("runs an accepted batch through the real worker with provider fakes", async () => {
    const { create, release, service } = integrationService();
    const workflow = navigationWorkflow();
    const secondWorkflow = {
      ...workflow,
      id: "33333333-3333-4333-8333-333333333333",
      name: "Private second workflow",
    };

    const created = await service.app.inject({
      method: "POST",
      url: "/v1/batches",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      payload: { runs: [{ workflow }, { workflow: secondWorkflow }] },
    });
    const batchId = created.json().batchId as string;

    await vi.waitFor(async () => {
      const polled = await service.app.inject({
        method: "GET",
        url: `/v1/batches/${batchId}`,
        headers: {
          accept: "application/json",
        },
      });
      expect(polled.json().runs.map((run: { status: string }) => run.status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(polled.body).not.toMatch(
        /example\.com|Private second workflow|private-provider|private-recording-session-id/,
      );
    });

    expect(created.statusCode).toBe(202);
    expect(create).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });

  it("rejects invalid workflow preflight without a paid session", async () => {
    const { create, service } = integrationService();

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "application/json",
      },
      payload: { workflow: { ...navigationWorkflow(), status: "draft" } },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "workflow_not_complete" } });
    expect(create).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it("runs workflows regardless of the declared schema version", async () => {
    const { create, service } = integrationService();

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "application/json",
      },
      payload: { workflow: { ...navigationWorkflow(), schemaVersion: "1.2" } },
    });

    expect(response.statusCode).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    await service.shutdown();
  });

  it("streams a real worker run while keeping provider details private", async () => {
    const { page, release, service } = integrationService();

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "application/json",
      },
      payload: { workflow: navigationWorkflow() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.trim().split("\n").map((line) => JSON.parse(line)).at(-1)).toMatchObject({
      type: "worker.outcome",
      status: "completed",
      cleanupStatus: "completed",
    });
    expect(response.body).not.toMatch(
      /example\.com|private-provider-session-id|private-provider-connect-url|private-recording-session-id/,
    );
    expect(page.goto).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("private-provider-session-id");
    await service.shutdown();
  });
});
