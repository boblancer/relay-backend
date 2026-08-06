import { Browserbase } from "@browserbasehq/sdk";
import {
  AutomationRunner,
  type AutomationEvent,
  type AutomationResult,
} from "@relay/automation-core";
import { chromium, type Browser, type Page } from "playwright-core";
import { prepareWorkflow, WorkerValidationError, type WorkerValidationCode } from "./prepare.js";

export type BrowserbaseRegion =
  | "us-west-2"
  | "us-east-1"
  | "eu-central-1"
  | "ap-southeast-1";

export interface BrowserbaseWorkerConfig {
  apiKey: string;
  projectId?: string;
  region?: BrowserbaseRegion;
  useProxy?: boolean;
  verified?: boolean;
  runTimeoutMs?: number;
  stepTimeoutMs?: number;
}

export interface BrowserbaseRunInput {
  workflow: unknown;
  startStepId?: string;
  parameterValues?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  onEvent?: (event: BrowserbaseWorkerEvent) => void;
  onTerminalScreenshot?: (screenshot: TerminalScreenshot) => Promise<void> | void;
}

export interface TerminalScreenshot {
  bytes: Buffer;
  mediaType: "image/png";
}

export interface BrowserbaseSessionOptions {
  projectId?: string;
  region: BrowserbaseRegion;
  proxies: boolean;
  keepAlive: false;
  timeout: number;
  browserSettings: {
    viewport: { width: number; height: number };
    solveCaptchas: true;
    recordSession: false;
    logSession: false;
    verified?: true;
  };
  userMetadata: { product: "relay"; purpose: "background-automation" };
}

export interface BrowserbaseSessionClient {
  create(
    options: BrowserbaseSessionOptions,
    signal: AbortSignal,
  ): Promise<{ id: string; connectUrl: string }>;
  release(sessionId: string): Promise<void>;
}

export interface BrowserbaseWorkerDependencies {
  sessionClient: BrowserbaseSessionClient;
  connect(connectUrl: string, timeoutMs: number): Promise<Browser>;
}

export type BrowserbaseWorkerEvent =
  | { type: "worker.started" }
  | { type: "browser.provisioning" }
  | { type: "browser.connected" }
  | AutomationEvent;

export type CleanupStatus = "not_started" | "completed" | "incomplete";

export type BrowserbaseWorkerFailureCode =
  | WorkerValidationCode
  | "invalid_configuration"
  | "browserbase_unavailable"
  | "browser_unavailable"
  | "automation_failed";

export type BrowserbaseRunOutcome =
  | {
      status: "completed";
      stage: "execution";
      result: Extract<AutomationResult, { status: "completed" }>;
      cleanupStatus: CleanupStatus;
    }
  | {
      status: "failed";
      stage: "validation" | "provisioning" | "execution";
      code: BrowserbaseWorkerFailureCode;
      result?: Extract<AutomationResult, { status: "failed" }>;
      cleanupStatus: CleanupStatus;
    }
  | {
      status: "cancelled" | "timed_out";
      stage: "provisioning" | "execution";
      result?: Extract<AutomationResult, { status: "cancelled" }>;
      cleanupStatus: CleanupStatus;
    };

type PendingOutcome = BrowserbaseRunOutcome extends infer Outcome
  ? Outcome extends BrowserbaseRunOutcome
    ? Omit<Outcome, "cleanupStatus">
    : never
  : never;

const defaultRunTimeoutMs = 600_000;
const defaultStepTimeoutMs = 60_000;
const terminalScreenshotTimeoutMs = 2_000;

async function captureTerminalScreenshot(page: Page, input: BrowserbaseRunInput): Promise<void> {
  if (!input.onTerminalScreenshot) return;
  let timeout: NodeJS.Timeout | undefined;
  const capture = Promise.resolve()
    .then(async () => {
      const bytes = await page.screenshot({ fullPage: false, type: "png" });
      await input.onTerminalScreenshot?.({ bytes, mediaType: "image/png" });
    })
    .catch(() => undefined);
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, terminalScreenshotTimeoutMs);
    timeout.unref();
  });
  await Promise.race([capture, deadline]);
  if (timeout) clearTimeout(timeout);
}

class SdkSessionClient implements BrowserbaseSessionClient {
  private readonly client: Browserbase;

  constructor(apiKey: string) {
    this.client = new Browserbase({ apiKey, maxRetries: 0 });
  }

  async create(options: BrowserbaseSessionOptions, signal: AbortSignal) {
    const session = await this.client.sessions.create(options, { signal });
    return { id: session.id, connectUrl: session.connectUrl };
  }

  async release(sessionId: string): Promise<void> {
    await this.client.sessions.update(sessionId, { status: "REQUEST_RELEASE" });
  }
}

function productionDependencies(config: BrowserbaseWorkerConfig): BrowserbaseWorkerDependencies {
  return {
    sessionClient: new SdkSessionClient(config.apiKey),
    connect: (connectUrl, timeoutMs) => chromium.connectOverCDP(connectUrl, { timeout: timeoutMs }),
  };
}

function validPositiveDuration(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Runs one finalized workflow in a fresh, caller-configured Browserbase session. */
export class BrowserbaseAutomationWorker {
  private readonly runTimeoutMs: number;
  private readonly stepTimeoutMs: number;

  constructor(
    private readonly config: BrowserbaseWorkerConfig,
    private readonly dependencies?: BrowserbaseWorkerDependencies,
  ) {
    this.runTimeoutMs = config.runTimeoutMs ?? defaultRunTimeoutMs;
    this.stepTimeoutMs = config.stepTimeoutMs ?? defaultStepTimeoutMs;
  }

  private emit(input: BrowserbaseRunInput, event: BrowserbaseWorkerEvent): void {
    input.onEvent?.(event);
  }

  /** Validates input before provisioning and always attempts cleanup after provisioning. */
  async run(input: BrowserbaseRunInput): Promise<BrowserbaseRunOutcome> {
    if (
      !this.config.apiKey.trim().length ||
      !validPositiveDuration(this.runTimeoutMs) ||
      !validPositiveDuration(this.stepTimeoutMs)
    ) {
      return {
        status: "failed",
        stage: "validation",
        code: "invalid_configuration",
        cleanupStatus: "not_started",
      };
    }

    let prepared;
    try {
      prepared = prepareWorkflow(
        input.workflow,
        input.startStepId,
        input.parameterValues ?? {},
      );
    } catch (error) {
      return {
        status: "failed",
        stage: "validation",
        code: error instanceof WorkerValidationError ? error.code : "invalid_workflow",
        cleanupStatus: "not_started",
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (input.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.runTimeoutMs);
    timeout.unref();

    let browser: Browser | undefined;
    let page: Page | undefined;
    let sessionId: string | undefined;
    let stage: "provisioning" | "execution" = "provisioning";
    let outcome: PendingOutcome;
    let dependencies = this.dependencies;
    try {
      dependencies ??= productionDependencies(this.config);
      this.emit(input, { type: "worker.started" });
      if (controller.signal.aborted) throw new Error("interrupted");
      this.emit(input, { type: "browser.provisioning" });
      const session = await dependencies.sessionClient.create(
        {
          ...(this.config.projectId ? { projectId: this.config.projectId } : {}),
          region: this.config.region ?? "us-west-2",
          proxies: this.config.useProxy ?? false,
          keepAlive: false,
          timeout: Math.min(21_600, Math.max(60, Math.ceil(this.runTimeoutMs / 1_000) + 60)),
          browserSettings: {
            viewport: { width: 1440, height: 900 },
            solveCaptchas: true,
            recordSession: false,
            logSession: false,
            ...(this.config.verified ? { verified: true as const } : {}),
          },
          userMetadata: { product: "relay", purpose: "background-automation" },
        },
        controller.signal,
      );
      sessionId = session.id;
      if (controller.signal.aborted) throw new Error("interrupted");
      browser = await dependencies.connect(session.connectUrl, this.stepTimeoutMs);
      if (controller.signal.aborted) throw new Error("interrupted");
      page = browser.contexts()[0]?.pages()[0];
      if (!page) {
        outcome = { status: "failed", stage, code: "browser_unavailable" };
      } else {
        this.emit(input, { type: "browser.connected" });
        stage = "execution";
        const result = await new AutomationRunner(page, {
          signal: controller.signal,
          stepTimeoutMs: this.stepTimeoutMs,
          onEvent: (event) => this.emit(input, event),
        }).run(prepared.preflight);
        if (result.status === "completed") {
          outcome = { status: "completed", stage, result };
        } else if (result.status === "failed") {
          outcome = { status: "failed", stage, code: "automation_failed", result };
        } else {
          outcome = { status: timedOut ? "timed_out" : "cancelled", stage, result };
        }
      }
    } catch {
      outcome = controller.signal.aborted
        ? { status: timedOut ? "timed_out" : "cancelled", stage }
        : {
            status: "failed",
            stage,
            code: sessionId ? "browser_unavailable" : "browserbase_unavailable",
          };
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onCallerAbort);
    }

    if (page) await captureTerminalScreenshot(page, input);

    const cleanupTasks: Array<Promise<void>> = [];
    if (browser) cleanupTasks.push(Promise.resolve().then(() => browser.close()));
    if (sessionId && dependencies) {
      cleanupTasks.push(Promise.resolve().then(() => dependencies.sessionClient.release(sessionId)));
    }
    const cleanup = await Promise.allSettled(cleanupTasks);
    const cleanupStatus: CleanupStatus = sessionId
      ? cleanup.every((item) => item.status === "fulfilled")
        ? "completed"
        : "incomplete"
      : "not_started";
    return { ...outcome, cleanupStatus } as BrowserbaseRunOutcome;
  }
}
