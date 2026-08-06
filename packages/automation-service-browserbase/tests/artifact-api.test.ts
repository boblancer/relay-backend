import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserbaseAutomationWorker,
  BrowserbaseRunInput,
  BrowserbaseRunOutcome,
  BrowserbaseWorkerConfig,
} from "@relay/automation-worker-browserbase";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAutomationService, type SafeLogRecord } from "../src/app.js";
import { ArtifactStore } from "../src/artifacts.js";
import type { AutomationServiceConfig } from "../src/config.js";

const directories: string[] = [];
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

async function screenshotPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1_440,
      height: 900,
      channels: 3,
      background: { r: 20, g: 60, b: 100 },
    },
  })
    .png()
    .toBuffer();
}

async function serviceFixture(ids: string[]) {
  const artifactDirectory = await mkdtemp(join(tmpdir(), "relay-artifact-api-test-"));
  directories.push(artifactDirectory);
  const logs: SafeLogRecord[] = [];
  let now = Date.parse("2026-08-05T22:00:00.000Z");
  const randomUUID = () => ids.shift()!;
  const artifactStore = new ArtifactStore({ directory: artifactDirectory, now: () => now, randomUUID });
  const run = vi.fn(async (input: BrowserbaseRunInput) => {
    input.onEvent?.({ type: "worker.started" });
    input.onEvent?.({ type: "run.started", totalSteps: 1 });
    await input.onTerminalScreenshot?.({ bytes: await screenshotPng(), mediaType: "image/png" });
    return completedOutcome;
  });
  const config: AutomationServiceConfig = {
    artifactDirectory,
    host: "127.0.0.1",
    inngestDev: false,
    port: 8080,
    maxConcurrentRuns: 5,
    retryAfterSeconds: 1,
    screenshotsEnabled: true,
    shutdownGraceMs: 30_000,
    worker: { apiKey: "browserbase-key" },
  };
  const service = buildAutomationService(config, {
    createWorker: vi.fn(() => ({ run })) as unknown as (
      workerConfig: BrowserbaseWorkerConfig,
    ) => BrowserbaseAutomationWorker,
    artifactStore,
    log: (record) => logs.push(record),
    randomUUID,
    registerInngest: vi.fn(),
  });
  return { advanceTime: (milliseconds: number) => (now += milliseconds), logs, service };
}

function completeWorkflow(id: string) {
  return { id, schemaVersion: "1.3", status: "complete" };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("terminal screenshot API", () => {
  it("adds a temporary thumbnail URL to the direct terminal outcome and serves the WebP", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const artifactId = "22222222-2222-4222-8222-222222222222";
    const { advanceTime, logs, service } = await serviceFixture([runId, artifactId]);

    const response = await service.app.inject({
      method: "POST",
      url: "/v1/run",
      headers: { accept: "application/x-ndjson", "content-type": "application/json" },
      payload: { workflow: completeWorkflow("33333333-3333-4333-8333-333333333333") },
    });
    const terminal = response.body.trim().split("\n").map((line) => JSON.parse(line)).at(-1);

    expect(terminal).toMatchObject({
      type: "worker.outcome",
      status: "completed",
      thumbnail: {
        url: `/v1/artifacts/${artifactId}`,
        mediaType: "image/webp",
        width: 480,
        height: 300,
      },
    });
    expect(JSON.stringify(logs)).not.toContain(artifactId);
    expect(response.body).not.toContain("private screenshot pixels");

    const image = await service.app.inject({
      method: "GET",
      url: terminal.thumbnail.url,
      headers: { accept: "image/webp" },
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/webp");
    expect(image.headers["cache-control"]).toBe("no-store");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(await sharp(image.rawPayload).metadata()).toMatchObject({ width: 480, height: 300 });

    advanceTime(60 * 60 * 1_000 + 1);
    const expired = await service.app.inject({
      method: "GET",
      url: terminal.thumbnail.url,
      headers: { accept: "image/webp" },
    });
    expect(expired.statusCode).toBe(404);

    await service.shutdown();
  });

  it("adds a thumbnail to a completed batch run and safely rejects unknown artifacts", async () => {
    const batchId = "44444444-4444-4444-8444-444444444444";
    const artifactId = "55555555-5555-4555-8555-555555555555";
    const { service } = await serviceFixture([batchId, artifactId]);
    const workflow = completeWorkflow("66666666-6666-4666-8666-666666666666");

    const created = await service.app.inject({
      method: "POST",
      url: "/v1/batches",
      headers: { accept: "application/json", "content-type": "application/json" },
      payload: { runs: [{ workflow }] },
    });
    let snapshot;
    await vi.waitFor(async () => {
      snapshot = await service.app.inject({
        method: "GET",
        url: `/v1/batches/${created.json().batchId}`,
        headers: { accept: "application/json" },
      });
      expect(snapshot.json().runs[0].status).toBe("completed");
    });

    expect(snapshot!.json().runs[0]).toMatchObject({
      workflowId: workflow.id,
      thumbnail: { url: `/v1/artifacts/${artifactId}`, mediaType: "image/webp" },
    });
    const unknown = await service.app.inject({
      method: "GET",
      url: "/v1/artifacts/77777777-7777-4777-8777-777777777777",
      headers: { accept: "image/webp" },
    });
    const invalid = await service.app.inject({
      method: "GET",
      url: "/v1/artifacts/not-a-uuid",
      headers: { accept: "image/webp" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: "artifact_not_found" } });
    expect(invalid.statusCode).toBe(400);

    await service.shutdown();
  });
});
