import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  BrowserbaseAutomationWorker,
  type BrowserbaseRunInput,
  type BrowserbaseRunOutcome,
  type BrowserbaseWorkerConfig,
  type BrowserbaseWorkerEvent,
  type TerminalScreenshot,
} from "@relay/automation-worker-browserbase";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  BatchCoordinator,
  type BatchRunInput,
  type ManagedRunOutcome,
} from "./batches/batch-coordinator.js";
import { ArtifactStore } from "./artifacts.js";
import type { AutomationServiceConfig } from "./config.js";
import {
  registerInngestFunctions,
  type InngestAdmissionCode,
  type InngestRunExecutor,
} from "./inngest.js";

const maximumRequestBytes = 1_048_576;
const heartbeatIntervalMs = 15_000;

type StepPhase = Extract<BrowserbaseWorkerEvent, { type: "step.phase" }>["phase"];
type StepSkipReason = Extract<BrowserbaseWorkerEvent, { type: "step.skipped" }>["reason"];

export type SafeLogRecord =
  | { event: "run.started"; runId: string }
  | {
      event: "run.finished";
      runId: string;
      status: BrowserbaseRunOutcome["status"];
      stage: BrowserbaseRunOutcome["stage"];
      code?: string;
      durationMs: number;
    }
  | { event: "run.rejected"; runId: string; code: string }
  | {
      event: "run.step";
      runId: string;
      stepIndex: number;
      status: "started" | "running" | "skipped" | "completed" | "failed" | "cancelled";
      phase?: StepPhase;
      reason?: StepSkipReason;
      durationMs?: number;
    };

interface RunWorker {
  run(input: BrowserbaseRunInput): Promise<BrowserbaseRunOutcome>;
}

export interface AutomationServiceDependencies {
  artifactStore?: Pick<ArtifactStore, "read" | "save">;
  createWorker(config: BrowserbaseWorkerConfig): RunWorker;
  log(record: SafeLogRecord): void;
  randomUUID(): string;
  registerInngest(app: FastifyInstance, execute: InngestRunExecutor): void;
}

export interface AutomationService {
  app: FastifyInstance;
  shutdown(): Promise<void>;
}

interface RunRequestBody {
  workflow: object;
  startStepId?: string;
  parameterValues?: Readonly<Record<string, string>>;
}

interface BatchRequestBody {
  runs: Array<{
    workflow: object & { id: string; schemaVersion: string; status: "complete" };
  }>;
}

const productionDependencies: AutomationServiceDependencies = {
  createWorker: (config) => new BrowserbaseAutomationWorker(config),
  log: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
  randomUUID: nodeRandomUUID,
  registerInngest: registerInngestFunctions,
};

const runRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["workflow"],
  properties: {
    workflow: { type: "object" },
    startStepId: { type: "string", minLength: 1 },
    parameterValues: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
} as const;

const batchRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runs"],
  properties: {
    runs: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["workflow"],
        properties: {
          workflow: {
            type: "object",
            required: ["id", "schemaVersion", "status"],
            properties: {
              id: { type: "string", format: "uuid" },
              schemaVersion: { type: "string" },
              status: { const: "complete" },
            },
          },
        },
      },
    },
  },
} as const;

const batchPathSchema = {
  type: "object",
  additionalProperties: false,
  required: ["batchId"],
  properties: { batchId: { type: "string", format: "uuid" } },
} as const;

const artifactPathSchema = {
  type: "object",
  additionalProperties: false,
  required: ["artifactId"],
  properties: { artifactId: { type: "string", format: "uuid" } },
} as const;

function safeError(code: string, message: string) {
  return { error: { code, message } };
}

function acceptsMediaType(header: string | undefined, expected: string): boolean {
  if (!header) return true;
  const expectedType = expected.split("/", 1)[0];
  return header.split(",").some((item) => {
    const [rawMediaType, ...parameters] = item.split(";");
    const mediaType = rawMediaType?.trim().toLowerCase();
    const qualityParameter = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith("q="));
    const quality = qualityParameter ? Number(qualityParameter.slice(2)) : 1;
    const mediaTypeMatches =
      mediaType === "*/*" || mediaType === `${expectedType}/*` || mediaType === expected;
    return mediaTypeMatches && Number.isFinite(quality) && quality > 0 && quality <= 1;
  });
}

function hasJsonContentType(request: FastifyRequest): boolean {
  return (
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

function writeLine(reply: FastifyReply, runId: string, value: object): void {
  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    reply.raw.write(`${JSON.stringify({ runId, ...value })}\n`);
  }
}

function failureCode(outcome: BrowserbaseRunOutcome): string | undefined {
  return outcome.status === "failed" ? outcome.code : undefined;
}

function safeStepLogRecord(
  runId: string,
  event: BrowserbaseWorkerEvent,
): SafeLogRecord | undefined {
  switch (event.type) {
    case "step.started":
      return { event: "run.step", runId, stepIndex: event.stepIndex, status: "started" };
    case "step.phase":
      return {
        event: "run.step",
        runId,
        stepIndex: event.stepIndex,
        status: "running",
        phase: event.phase,
      };
    case "step.skipped":
      return {
        event: "run.step",
        runId,
        stepIndex: event.stepIndex,
        status: "skipped",
        reason: event.reason,
      };
    case "step.completed":
      return {
        event: "run.step",
        runId,
        stepIndex: event.stepIndex,
        status: "completed",
        durationMs: event.durationMs,
      };
    case "step.failed":
      return {
        event: "run.step",
        runId,
        stepIndex: event.stepIndex,
        status: "failed",
        phase: event.phase,
      };
    case "step.cancelled":
      return { event: "run.step", runId, stepIndex: event.stepIndex, status: "cancelled" };
    default:
      return undefined;
  }
}

export function buildAutomationService(
  config: AutomationServiceConfig,
  dependencies: AutomationServiceDependencies = productionDependencies,
): AutomationService {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: maximumRequestBytes,
    logger: false,
  });
  const worker = dependencies.createWorker(config.worker);
  const artifactStore =
    dependencies.artifactStore ??
    new ArtifactStore({
      directory: config.artifactDirectory,
      randomUUID: dependencies.randomUUID,
    });
  const activeRuns = new Map<AbortController, Promise<ManagedRunOutcome>>();
  let shuttingDown = false;
  let notifyRunSettled = () => {};
  const safeLog = (record: SafeLogRecord) => {
    try {
      dependencies.log(record);
    } catch {
      // Observability is best-effort and must never change browser side effects or outcomes.
    }
  };

  const admissionCode = (): InngestAdmissionCode | undefined => {
    if (shuttingDown) return "shutting_down";
    if (activeRuns.size >= config.maxConcurrentRuns) return "at_capacity";
    return undefined;
  };

  const startManagedRun = (
    input: Omit<BrowserbaseRunInput, "signal">,
    options: { captureScreenshot?: boolean; controller?: AbortController } = {},
  ) => {
    const controller = options.controller ?? new AbortController();
    let thumbnail: ManagedRunOutcome["thumbnail"];
    let acceptsThumbnail = true;
    const onTerminalScreenshot =
      config.screenshotsEnabled && options.captureScreenshot !== false
        ? async (screenshot: TerminalScreenshot) => {
            const saved = await artifactStore.save(screenshot);
            if (acceptsThumbnail) thumbnail = saved;
          }
        : undefined;
    const runPromise = Promise.resolve()
      .then(() =>
        worker.run({
          ...input,
          signal: controller.signal,
          ...(onTerminalScreenshot ? { onTerminalScreenshot } : {}),
        }),
      )
      .then((outcome): ManagedRunOutcome => {
        acceptsThumbnail = false;
        return thumbnail ? { ...outcome, thumbnail } : outcome;
      })
      .finally(() => {
        activeRuns.delete(controller);
        notifyRunSettled();
      });
    activeRuns.set(controller, runPromise);
    return runPromise;
  };

  const batchCoordinator = new BatchCoordinator({
    randomUUID: dependencies.randomUUID,
    tryStart: (input) => (admissionCode() ? undefined : startManagedRun(input)),
  });
  notifyRunSettled = () => batchCoordinator.drain();

  const executeInngestRun: InngestRunExecutor = async (input) => {
    const code = admissionCode();
    if (code) return { accepted: false, code };
    return {
      accepted: true,
      outcome: await startManagedRun(input, { captureScreenshot: false }),
    };
  };

  app.setErrorHandler((error, _request, reply) => {
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    if (status === 413) {
      return reply.status(413).send(safeError("request_too_large", "The request exceeds 1 MiB."));
    }
    if (status === 415) {
      return reply
        .status(415)
        .send(safeError("unsupported_media_type", "Content-Type must be application/json."));
    }
    if (status === 400) {
      return reply.status(400).send(safeError("invalid_request", "The request is invalid."));
    }
    return reply.status(500).send(safeError("internal", "The automation service failed."));
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    if (shuttingDown) return reply.status(503).send({ status: "shutting_down" });
    return { status: "ok" };
  });

  async function validateRunMedia(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!hasJsonContentType(request)) {
      await reply
        .status(415)
        .send(safeError("unsupported_media_type", "Content-Type must be application/json."));
      return;
    }
    if (!acceptsMediaType(request.headers.accept, "application/x-ndjson")) {
      await reply
        .status(406)
        .send(safeError("not_acceptable", "Accept must allow application/x-ndjson."));
    }
  }

  async function validateBatchCreateMedia(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!hasJsonContentType(request)) {
      await reply
        .status(415)
        .send(safeError("unsupported_media_type", "Content-Type must be application/json."));
      return;
    }
    if (!acceptsMediaType(request.headers.accept, "application/json")) {
      await reply
        .status(406)
        .send(safeError("not_acceptable", "Accept must allow application/json."));
    }
  }

  async function validateBatchPollMedia(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!acceptsMediaType(request.headers.accept, "application/json")) {
      await reply
        .status(406)
        .send(safeError("not_acceptable", "Accept must allow application/json."));
    }
  }

  app.post<{ Body: RunRequestBody }>(
    "/v1/run",
    { onRequest: validateRunMedia, schema: { body: runRequestSchema } },
    async (request, reply) => {
      const runId = dependencies.randomUUID();
      reply.header("X-Run-Id", runId);
      const code = admissionCode();
      if (code === "shutting_down") {
        return reply.status(503).send(safeError("shutting_down", "The service is shutting down."));
      }
      if (code === "at_capacity") {
        return reply
          .header("Retry-After", String(config.retryAfterSeconds))
          .status(429)
          .send(safeError("at_capacity", "The service is at run capacity."));
      }

      const controller = new AbortController();
      const startedAt = Date.now();
      let streamStarted = false;
      let requestSettled = false;
      let heartbeat: NodeJS.Timeout | undefined;
      const abortIfDisconnected = () => {
        if (!requestSettled) controller.abort();
      };
      request.raw.once("aborted", abortIfDisconnected);
      reply.raw.once("close", abortIfDisconnected);

      const startStream = () => {
        if (streamStarted) return;
        streamStarted = true;
        reply.hijack();
        reply.raw.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/x-ndjson",
          "X-Accel-Buffering": "no",
          "X-Run-Id": runId,
        });
        heartbeat = setInterval(
          () => writeLine(reply, runId, { type: "heartbeat" }),
          heartbeatIntervalMs,
        );
        heartbeat.unref();
        safeLog({ event: "run.started", runId });
      };

      const onEvent = (event: BrowserbaseWorkerEvent) => {
        startStream();
        const stepLog = safeStepLogRecord(runId, event);
        if (stepLog) safeLog(stepLog);
        writeLine(reply, runId, event);
      };
      const input: BrowserbaseRunInput = {
        workflow: request.body.workflow,
        parameterValues: request.body.parameterValues ?? {},
        onEvent,
        ...(request.body.startStepId ? { startStepId: request.body.startStepId } : {}),
      };

      const runPromise = startManagedRun(input, { controller });
      let outcome: ManagedRunOutcome;
      try {
        outcome = await runPromise;
      } catch {
        outcome = {
          status: "failed",
          stage: streamStarted ? "execution" : "validation",
          code: streamStarted ? "automation_failed" : "invalid_configuration",
          cleanupStatus: "incomplete",
        };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        request.raw.removeListener("aborted", abortIfDisconnected);
      }

      if (!streamStarted) {
        requestSettled = true;
        reply.raw.removeListener("close", abortIfDisconnected);
        const code = failureCode(outcome) ?? "invalid_workflow";
        safeLog({ event: "run.rejected", runId, code });
        if (
          outcome.status === "failed" &&
          outcome.stage === "validation" &&
          code !== "invalid_configuration"
        ) {
          return reply
            .status(422)
            .send(safeError(code, "The automation run input is invalid."));
        }
        return reply.status(500).send(safeError("internal", "The automation service failed."));
      }

      writeLine(reply, runId, { type: "worker.outcome", ...outcome });
      requestSettled = true;
      reply.raw.removeListener("close", abortIfDisconnected);
      safeLog({
        event: "run.finished",
        runId,
        status: outcome.status,
        stage: outcome.stage,
        ...(failureCode(outcome) ? { code: failureCode(outcome) } : {}),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      reply.raw.end();
      return reply;
    },
  );

  app.post<{ Body: BatchRequestBody }>(
    "/v1/batches",
    { onRequest: validateBatchCreateMedia, schema: { body: batchRequestSchema } },
    async (request, reply) => {
      if (shuttingDown) {
        return reply.status(503).send(safeError("shutting_down", "The service is shutting down."));
      }
      const inputs: BatchRunInput[] = request.body.runs.map(({ workflow }) => ({
        workflowId: workflow.id,
        workflow,
      }));
      const created = batchCoordinator.createBatch(inputs);
      if (!created) {
        return reply
          .status(429)
          .send(safeError("batch_capacity", "The service is at batch capacity."));
      }
      return reply.header("Cache-Control", "no-store").status(202).send(created);
    },
  );

  app.get<{ Params: { batchId: string } }>(
    "/v1/batches/:batchId",
    { onRequest: validateBatchPollMedia, schema: { params: batchPathSchema } },
    async (request, reply) => {
      const snapshot = batchCoordinator.getBatch(request.params.batchId);
      if (!snapshot) {
        return reply
          .header("Cache-Control", "no-store")
          .status(404)
          .send(safeError("batch_not_found", "The batch is unknown or expired."));
      }
      return reply.header("Cache-Control", "no-store").send(snapshot);
    },
  );

  app.get<{ Params: { artifactId: string } }>(
    "/v1/artifacts/:artifactId",
    { schema: { params: artifactPathSchema } },
    async (request, reply) => {
      if (!acceptsMediaType(request.headers.accept, "image/webp")) {
        return reply
          .status(406)
          .send(safeError("not_acceptable", "Accept must allow image/webp."));
      }
      const artifact = await artifactStore.read(request.params.artifactId);
      if (!artifact) {
        return reply
          .header("Cache-Control", "no-store")
          .status(404)
          .send(safeError("artifact_not_found", "The artifact is unknown or expired."));
      }
      return reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .type(artifact.mediaType)
        .send(artifact.bytes);
    },
  );

  if (config.inngestDev) {
    dependencies.registerInngest(app, executeInngestRun);
  }

  return {
    app,
    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      batchCoordinator.stop();
      for (const controller of activeRuns.keys()) controller.abort();
      if (activeRuns.size) {
        let grace: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled(activeRuns.values()),
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, config.shutdownGraceMs);
            grace.unref();
          }),
        ]);
        if (grace) clearTimeout(grace);
      }
      await app.close();
    },
  };
}
