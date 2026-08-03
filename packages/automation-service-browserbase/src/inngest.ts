import {
  type BrowserbaseRunOutcome,
  type BrowserbaseWorkerFailureCode,
} from "@relay/automation-worker-browserbase";
import type { FastifyInstance } from "fastify";
import {
  ConsoleLogger,
  eventType,
  Inngest,
  type InngestFunction,
  staticSchema,
} from "inngest";
import { fastifyPlugin } from "inngest/fastify";

const eventName = "relay/automation.run.requested";
const stepId = "execute-browserbase-workflow";
const allowedEventFields = new Set(["workflow", "startStepId", "parameterValues"]);

export interface InngestRunInput {
  workflow: object;
  startStepId?: string;
  parameterValues?: Readonly<Record<string, string>>;
}

export type InngestAdmissionCode = "at_capacity" | "shutting_down";

export type InngestRunExecution =
  | { accepted: true; outcome: BrowserbaseRunOutcome }
  | { accepted: false; code: InngestAdmissionCode };

export type InngestRunExecutor = (input: InngestRunInput) => Promise<InngestRunExecution>;

export type SafeInngestOutcome =
  | {
      status: BrowserbaseRunOutcome["status"];
      stage: BrowserbaseRunOutcome["stage"];
      code?: BrowserbaseWorkerFailureCode;
      cleanupStatus: BrowserbaseRunOutcome["cleanupStatus"];
    }
  | {
      status: "failed";
      stage: "validation" | "orchestration";
      code: "invalid_event" | InngestAdmissionCode;
      cleanupStatus: "not_started";
    };

export type StepRunner = (
  id: string,
  callback: () => Promise<SafeInngestOutcome>,
) => Promise<SafeInngestOutcome>;

interface RunRequestedEventData extends Record<string, unknown> {
  workflow: object;
  startStepId?: string;
  parameterValues?: Readonly<Record<string, string>>;
}

const runRequested = eventType(eventName, {
  schema: staticSchema<RunRequestedEventData>(),
});

const silentLogger = new ConsoleLogger({ level: "silent" });

export const inngest = new Inngest({
  id: "relay-browserbase-poc",
  isDev: true,
  logger: silentLogger,
  internalLogger: silentLogger,
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEventData(value: unknown): InngestRunInput | undefined {
  if (!isObject(value) || Object.keys(value).some((key) => !allowedEventFields.has(key))) {
    return undefined;
  }
  if (!Object.hasOwn(value, "workflow") || !isObject(value.workflow)) return undefined;
  if (value.startStepId !== undefined && (typeof value.startStepId !== "string" || !value.startStepId)) {
    return undefined;
  }
  if (value.parameterValues !== undefined) {
    if (!isObject(value.parameterValues)) return undefined;
    if (Object.values(value.parameterValues).some((item) => typeof item !== "string")) {
      return undefined;
    }
  }
  return {
    workflow: value.workflow,
    ...(value.startStepId ? { startStepId: value.startStepId } : {}),
    ...(value.parameterValues
      ? { parameterValues: value.parameterValues as Readonly<Record<string, string>> }
      : {}),
  };
}

function safeWorkerOutcome(outcome: BrowserbaseRunOutcome): SafeInngestOutcome {
  return {
    status: outcome.status,
    stage: outcome.stage,
    ...(outcome.status === "failed" ? { code: outcome.code } : {}),
    cleanupStatus: outcome.cleanupStatus,
  };
}

export async function runBrowserbaseAutomationEvent(
  eventData: unknown,
  runStep: StepRunner,
  execute: InngestRunExecutor,
): Promise<SafeInngestOutcome> {
  const input = parseEventData(eventData);
  if (!input) {
    return {
      status: "failed",
      stage: "validation",
      code: "invalid_event",
      cleanupStatus: "not_started",
    };
  }

  return runStep(stepId, async () => {
    try {
      const execution = await execute(input);
      if (!execution.accepted) {
        return {
          status: "failed",
          stage: "orchestration",
          code: execution.code,
          cleanupStatus: "not_started",
        };
      }
      return safeWorkerOutcome(execution.outcome);
    } catch {
      return {
        status: "failed",
        stage: "execution",
        code: "automation_failed",
        cleanupStatus: "incomplete",
      };
    }
  });
}

export function createBrowserbaseAutomationFunction(
  execute: InngestRunExecutor,
): InngestFunction.Any {
  return inngest.createFunction(
    {
      id: "browserbase-automation-run",
      triggers: [runRequested],
      retries: 0,
      concurrency: 1,
    },
    async ({ event, step }) =>
      runBrowserbaseAutomationEvent(
        event.data,
        (id, callback) => step.run(id, callback) as Promise<SafeInngestOutcome>,
        execute,
      ),
  );
}

export function registerInngestFunctions(
  app: FastifyInstance,
  execute: InngestRunExecutor,
): void {
  app.register(fastifyPlugin, {
    client: inngest,
    functions: [createBrowserbaseAutomationFunction(execute)],
    options: {
      enableUnauthedSync: false,
      servePath: "/api/inngest",
    },
  });
}
