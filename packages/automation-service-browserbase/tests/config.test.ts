import { describe, expect, it } from "vitest";
import { ConfigurationError, loadServiceConfig } from "../src/config.js";

const requiredEnvironment = {
  BROWSERBASE_API_KEY: "browserbase-key",
};

describe("loadServiceConfig", () => {
  it("uses conservative service and worker defaults", () => {
    expect(loadServiceConfig(requiredEnvironment)).toEqual({
      artifactDirectory: expect.stringMatching(/\/\.relay\/artifacts$/),
      host: "127.0.0.1",
      port: 8080,
      maxConcurrentRuns: 5,
      inngestDev: false,
      retryAfterSeconds: 1,
      screenshotsEnabled: true,
      shutdownGraceMs: 30_000,
      worker: {
        apiKey: "browserbase-key",
        region: "us-west-2",
        runTimeoutMs: 600_000,
        stepTimeoutMs: 60_000,
        useProxy: false,
        verified: false,
      },
    });
  });

  it("treats an empty local Inngest opt-in as disabled", () => {
    expect(loadServiceConfig({ ...requiredEnvironment, INNGEST_DEV: "" })).toMatchObject({
      inngestDev: false,
    });
  });

  it("defaults the local Inngest POC to the loopback interface", () => {
    expect(loadServiceConfig({ ...requiredEnvironment, INNGEST_DEV: "1" })).toMatchObject({
      host: "127.0.0.1",
      inngestDev: true,
    });
  });

  it("allows a non-loopback host only when screenshots and Inngest are disabled", () => {
    expect(
      loadServiceConfig({
        ...requiredEnvironment,
        AUTOMATION_HOST: "0.0.0.0",
        AUTOMATION_SCREENSHOTS: "false",
      }),
    ).toMatchObject({ host: "0.0.0.0", inngestDev: false, screenshotsEnabled: false });
  });

  it("parses explicit operator-controlled settings", () => {
    expect(
      loadServiceConfig({
        ...requiredEnvironment,
        AUTOMATION_HOST: "127.0.0.1",
        AUTOMATION_MAX_CONCURRENT_RUNS: "3",
        AUTOMATION_ARTIFACT_DIR: "/tmp/relay-artifacts",
        AUTOMATION_RETRY_AFTER_SECONDS: "5",
        AUTOMATION_RUN_TIMEOUT_MS: "300000",
        AUTOMATION_SHUTDOWN_GRACE_MS: "15000",
        AUTOMATION_SCREENSHOTS: "false",
        AUTOMATION_STEP_TIMEOUT_MS: "30000",
        BROWSERBASE_PROJECT_ID: "project-id",
        BROWSERBASE_REGION: "eu-central-1",
        BROWSERBASE_USE_PROXY: "true",
        BROWSERBASE_VERIFIED: "true",
        INNGEST_DEV: "1",
        PORT: "9000",
      }),
    ).toMatchObject({
      host: "127.0.0.1",
      artifactDirectory: "/tmp/relay-artifacts",
      inngestDev: true,
      maxConcurrentRuns: 3,
      port: 9000,
      retryAfterSeconds: 5,
      screenshotsEnabled: false,
      shutdownGraceMs: 15_000,
      worker: {
        projectId: "project-id",
        region: "eu-central-1",
        runTimeoutMs: 300_000,
        stepTimeoutMs: 30_000,
        useProxy: true,
        verified: true,
      },
    });
  });

  it.each([
    [{}, "invalid_browserbase_configuration"],
    [{ ...requiredEnvironment, BROWSERBASE_API_KEY: " " }, "invalid_browserbase_configuration"],
    [{ ...requiredEnvironment, PORT: "0" }, "invalid_server_configuration"],
    [{ ...requiredEnvironment, AUTOMATION_MAX_CONCURRENT_RUNS: "1.5" }, "invalid_server_configuration"],
    [{ ...requiredEnvironment, AUTOMATION_RUN_TIMEOUT_MS: "600001" }, "invalid_server_configuration"],
    [{ ...requiredEnvironment, AUTOMATION_STEP_TIMEOUT_MS: "60001" }, "invalid_server_configuration"],
    [{ ...requiredEnvironment, AUTOMATION_SCREENSHOTS: "yes" }, "invalid_server_configuration"],
    [{ ...requiredEnvironment, AUTOMATION_HOST: "0.0.0.0" }, "invalid_server_configuration"],
    [{ ...requiredEnvironment, INNGEST_DEV: "true" }, "invalid_server_configuration"],
    [
      { ...requiredEnvironment, AUTOMATION_HOST: "0.0.0.0", INNGEST_DEV: "1" },
      "invalid_server_configuration",
    ],
    [{ ...requiredEnvironment, BROWSERBASE_USE_PROXY: "yes" }, "invalid_browserbase_configuration"],
    [{ ...requiredEnvironment, BROWSERBASE_REGION: "moon-1" }, "invalid_browserbase_configuration"],
  ])("rejects invalid configuration without exposing its value", (environment, expectedCode) => {
    let error: unknown;
    try {
      loadServiceConfig(environment);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({ code: expectedCode });
    expect(String(error)).not.toMatch(/too-short|yes|moon-1|600001|60001/);
  });
});
