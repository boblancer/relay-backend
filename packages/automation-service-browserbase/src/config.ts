import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BrowserbaseRegion,
  BrowserbaseWorkerConfig,
} from "@relay/automation-worker-browserbase";

export type ConfigurationErrorCode =
  | "invalid_browserbase_configuration"
  | "invalid_server_configuration";

export class ConfigurationError extends Error {
  constructor(readonly code: ConfigurationErrorCode) {
    super("The automation service configuration is invalid.");
    this.name = "ConfigurationError";
  }
}

export interface AutomationServiceConfig {
  artifactDirectory: string;
  host: string;
  inngestDev: boolean;
  port: number;
  maxConcurrentRuns: number;
  retryAfterSeconds: number;
  screenshotsEnabled: boolean;
  shutdownGraceMs: number;
  worker: BrowserbaseWorkerConfig;
}

const regions = new Set<BrowserbaseRegion>([
  "us-west-2",
  "us-east-1",
  "eu-central-1",
  "ap-southeast-1",
]);
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const defaultArtifactDirectory = resolve(
  fileURLToPath(new URL("../../../.relay/artifacts/", import.meta.url)),
);

function requiredSecret(
  value: string | undefined,
  code: ConfigurationErrorCode,
  minimumBytes = 1,
): string {
  if (!value?.trim() || value !== value.trim() || Buffer.byteLength(value) < minimumBytes) {
    throw new ConfigurationError(code);
  }
  return value;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError("invalid_server_configuration");
  }
  return parsed;
}

function strictBoolean(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new ConfigurationError("invalid_browserbase_configuration");
}

function strictOptIn(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "1") return true;
  throw new ConfigurationError("invalid_server_configuration");
}

function screenshotsEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new ConfigurationError("invalid_server_configuration");
}

function artifactDirectory(value: string | undefined): string {
  if (value === undefined) return defaultArtifactDirectory;
  if (!value.trim() || value !== value.trim()) {
    throw new ConfigurationError("invalid_server_configuration");
  }
  return resolve(value);
}

export function loadServiceConfig(environment: NodeJS.ProcessEnv): AutomationServiceConfig {
  const apiKey = requiredSecret(
    environment.BROWSERBASE_API_KEY,
    "invalid_browserbase_configuration",
  );
  const region = environment.BROWSERBASE_REGION ?? "us-west-2";
  if (!regions.has(region as BrowserbaseRegion)) {
    throw new ConfigurationError("invalid_browserbase_configuration");
  }
  const inngestDev = strictOptIn(environment.INNGEST_DEV);
  const host = environment.AUTOMATION_HOST?.trim() || "127.0.0.1";
  const screenshots = screenshotsEnabled(environment.AUTOMATION_SCREENSHOTS);
  if ((inngestDev || screenshots) && !loopbackHosts.has(host)) {
    throw new ConfigurationError("invalid_server_configuration");
  }

  return {
    artifactDirectory: artifactDirectory(environment.AUTOMATION_ARTIFACT_DIR),
    host,
    inngestDev,
    port: boundedInteger(environment.PORT, 8080, 1, 65_535),
    maxConcurrentRuns: boundedInteger(
      environment.AUTOMATION_MAX_CONCURRENT_RUNS,
      5,
      1,
      1_000,
    ),
    retryAfterSeconds: boundedInteger(
      environment.AUTOMATION_RETRY_AFTER_SECONDS,
      1,
      1,
      3_600,
    ),
    screenshotsEnabled: screenshots,
    shutdownGraceMs: boundedInteger(
      environment.AUTOMATION_SHUTDOWN_GRACE_MS,
      30_000,
      1,
      300_000,
    ),
    worker: {
      apiKey,
      ...(environment.BROWSERBASE_PROJECT_ID
        ? { projectId: environment.BROWSERBASE_PROJECT_ID }
        : {}),
      region: region as BrowserbaseRegion,
      useProxy: strictBoolean(environment.BROWSERBASE_USE_PROXY),
      verified: strictBoolean(environment.BROWSERBASE_VERIFIED),
      runTimeoutMs: boundedInteger(
        environment.AUTOMATION_RUN_TIMEOUT_MS,
        600_000,
        1,
        600_000,
      ),
      stepTimeoutMs: boundedInteger(
        environment.AUTOMATION_STEP_TIMEOUT_MS,
        60_000,
        1,
        60_000,
      ),
    },
  };
}
