import { createHash, randomUUID as nodeRandomUUID, timingSafeEqual } from "node:crypto";
import {
  BrowserbaseAutomationWorker,
  type BrowserbaseRunInput,
  type BrowserbaseRunOutcome,
  type BrowserbaseWorkerConfig,
  type BrowserbaseWorkerEvent,
} from "@relay/automation-worker-browserbase";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { AutomationServiceConfig } from "./config.js";

const maximumRequestBytes = 1_048_576;
const heartbeatIntervalMs = 15_000;

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
  | { event: "run.rejected"; runId: string; code: string };

interface RunWorker {
  run(input: BrowserbaseRunInput): Promise<BrowserbaseRunOutcome>;
}

export interface AutomationServiceDependencies {
  createWorker(config: BrowserbaseWorkerConfig): RunWorker;
  log(record: SafeLogRecord): void;
  randomUUID(): string;
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

const productionDependencies: AutomationServiceDependencies = {
  createWorker: (config) => new BrowserbaseAutomationWorker(config),
  log: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
  randomUUID: nodeRandomUUID,
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

function safeError(code: string, message: string) {
  return { error: { code, message } };
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match?.[1]) return false;
  const providedDigest = createHash("sha256").update(match[1]).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function acceptsNdjson(header: string | undefined): boolean {
  if (!header) return true;
  return header.split(",").some((item) => {
    const [rawMediaType, ...parameters] = item.split(";");
    const mediaType = rawMediaType?.trim().toLowerCase();
    const qualityParameter = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith("q="));
    const quality = qualityParameter ? Number(qualityParameter.slice(2)) : 1;
    const mediaTypeMatches =
      mediaType === "*/*" ||
      mediaType === "application/*" ||
      mediaType === "application/x-ndjson";
    return mediaTypeMatches && Number.isFinite(quality) && quality > 0 && quality <= 1;
  });
}

function writeLine(reply: FastifyReply, runId: string, value: object): void {
  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    reply.raw.write(`${JSON.stringify({ runId, ...value })}\n`);
  }
}

function failureCode(outcome: BrowserbaseRunOutcome): string | undefined {
  return outcome.status === "failed" ? outcome.code : undefined;
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
  const activeRuns = new Map<AbortController, Promise<BrowserbaseRunOutcome>>();
  let shuttingDown = false;
  const safeLog = (record: SafeLogRecord) => {
    try {
      dependencies.log(record);
    } catch {
      // Observability is best-effort and must never change browser side effects or outcomes.
    }
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
      return reply.status(400).send(safeError("invalid_request", "The run request is invalid."));
    }
    return reply.status(500).send(safeError("internal", "The automation service failed."));
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    if (shuttingDown) return reply.status(503).send({ status: "shutting_down" });
    return { status: "ok" };
  });

  async function authorize(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!tokenMatches(request.headers.authorization, config.serviceToken)) {
      await reply
        .header("WWW-Authenticate", "Bearer")
        .status(401)
        .send(safeError("unauthorized", "Authentication is required."));
      return;
    }
    const contentType = request.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      await reply
        .status(415)
        .send(safeError("unsupported_media_type", "Content-Type must be application/json."));
      return;
    }
    if (!acceptsNdjson(request.headers.accept)) {
      await reply
        .status(406)
        .send(safeError("not_acceptable", "Accept must allow application/x-ndjson."));
    }
  }

  app.post<{ Body: RunRequestBody }>(
    "/v1/run",
    { onRequest: authorize, schema: { body: runRequestSchema } },
    async (request, reply) => {
      const runId = dependencies.randomUUID();
      reply.header("X-Run-Id", runId);
      if (shuttingDown) {
        return reply.status(503).send(safeError("shutting_down", "The service is shutting down."));
      }
      if (activeRuns.size >= config.maxConcurrentRuns) {
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
        writeLine(reply, runId, event);
      };
      const input: BrowserbaseRunInput = {
        workflow: request.body.workflow,
        parameterValues: request.body.parameterValues ?? {},
        signal: controller.signal,
        onEvent,
        ...(request.body.startStepId ? { startStepId: request.body.startStepId } : {}),
      };

      const runPromise = worker.run(input);
      activeRuns.set(controller, runPromise);
      let outcome: BrowserbaseRunOutcome;
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
        activeRuns.delete(controller);
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

  return {
    app,
    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
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
