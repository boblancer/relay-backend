import type {
  BrowserbaseRegion,
  BrowserbaseWorkerConfig,
} from "@relay/automation-worker-browserbase";

export type ConfigurationErrorCode =
  | "invalid_browserbase_configuration"
  | "invalid_server_configuration"
  | "invalid_service_token";

export class ConfigurationError extends Error {
  constructor(readonly code: ConfigurationErrorCode) {
    super("The automation service configuration is invalid.");
    this.name = "ConfigurationError";
  }
}

export interface AutomationServiceConfig {
  host: string;
  port: number;
  maxConcurrentRuns: number;
  retryAfterSeconds: number;
  shutdownGraceMs: number;
  serviceToken: string;
  worker: BrowserbaseWorkerConfig;
}

const regions = new Set<BrowserbaseRegion>([
  "us-west-2",
  "us-east-1",
  "eu-central-1",
  "ap-southeast-1",
]);

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

export function loadServiceConfig(environment: NodeJS.ProcessEnv): AutomationServiceConfig {
  const apiKey = requiredSecret(
    environment.BROWSERBASE_API_KEY,
    "invalid_browserbase_configuration",
  );
  const serviceToken = requiredSecret(
    environment.AUTOMATION_SERVICE_TOKEN,
    "invalid_service_token",
    32,
  );
  const region = environment.BROWSERBASE_REGION ?? "us-west-2";
  if (!regions.has(region as BrowserbaseRegion)) {
    throw new ConfigurationError("invalid_browserbase_configuration");
  }

  return {
    host: environment.AUTOMATION_HOST?.trim() || "0.0.0.0",
    port: boundedInteger(environment.PORT, 8080, 1, 65_535),
    maxConcurrentRuns: boundedInteger(
      environment.AUTOMATION_MAX_CONCURRENT_RUNS,
      1,
      1,
      1_000,
    ),
    retryAfterSeconds: boundedInteger(
      environment.AUTOMATION_RETRY_AFTER_SECONDS,
      1,
      1,
      3_600,
    ),
    shutdownGraceMs: boundedInteger(
      environment.AUTOMATION_SHUTDOWN_GRACE_MS,
      30_000,
      1,
      300_000,
    ),
    serviceToken,
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
