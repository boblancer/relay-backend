import { expect, it } from "vitest";
import type { Workflow } from "@relay/automation-core";
import { BrowserbaseAutomationWorker } from "../src/index.js";

const enabled = process.env.BROWSERBASE_E2E === "1";

it.skipIf(!enabled)("runs a navigation-only workflow in Browserbase", async () => {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  expect(apiKey, "BROWSERBASE_API_KEY is required when BROWSERBASE_E2E=1").toBeTruthy();
  const now = new Date().toISOString();
  const workflow: Workflow = {
    schemaVersion: "1.3",
    id: "05b6300c-27c4-4931-8e89-a4b2223d9d8e",
    name: "Browserbase smoke",
    status: "complete",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    source: { provider: "browserbase", sessionId: "" },
    steps: [
      {
        id: "navigate",
        order: 0,
        name: "Open smoke page",
        enabled: true,
        page: { id: "page-1", url: "https://example.com" },
        metadata: { recordedAt: now, origin: "manual", sensitive: false },
        type: "navigate",
        payload: { url: "https://example.com" },
      },
    ],
  };
  const worker = new BrowserbaseAutomationWorker({
    apiKey: apiKey!,
    ...(process.env.BROWSERBASE_PROJECT_ID
      ? { projectId: process.env.BROWSERBASE_PROJECT_ID }
      : {}),
  });

  const outcome = await worker.run({ workflow });

  expect(outcome).toMatchObject({
    status: "completed",
    stage: "execution",
    cleanupStatus: "completed",
  });
});
