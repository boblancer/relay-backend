#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { BrowserbaseAutomationWorker } from "./worker.js";
import type {
  BrowserbaseRegion,
  BrowserbaseRunOutcome,
  BrowserbaseWorkerConfig,
} from "./worker.js";
import { prepareWorkflow, WorkerValidationError } from "./prepare.js";

const maxInputBytes = 1_048_576;
const regions = new Set<BrowserbaseRegion>([
  "us-west-2",
  "us-east-1",
  "eu-central-1",
  "ap-southeast-1",
]);

type CliCommand = "validate" | "run";

interface CliOptions {
  command: CliCommand;
  workflowPath: string;
  startStepId?: string;
  parametersPath?: string;
}

export interface CliDependencies {
  readFile(path: string): Promise<Buffer>;
  write(line: string): void;
  createWorker(config: BrowserbaseWorkerConfig): BrowserbaseAutomationWorker;
  signal?: AbortSignal;
}

const productionDependencies: CliDependencies = {
  readFile,
  write: (line) => process.stdout.write(`${line}\n`),
  createWorker: (config) => new BrowserbaseAutomationWorker(config),
};

class CliInputError extends Error {
  constructor(readonly code: string) {
    super("The command input is invalid.");
    this.name = "CliInputError";
  }
}

function writeJson(dependencies: CliDependencies, value: object): void {
  dependencies.write(JSON.stringify(value));
}

function parseArgs(argv: readonly string[]): CliOptions {
  const [command, ...args] = argv;
  if (command !== "validate" && command !== "run") {
    throw new CliInputError("invalid_invocation");
  }
  const values = new Map<string, string>();
  const allowed = new Set(["--workflow", "--start-step", "--parameters-file"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !allowed.has(flag) || !value || values.has(flag)) {
      throw new CliInputError("invalid_invocation");
    }
    values.set(flag, value);
  }
  const workflowPath = values.get("--workflow");
  if (!workflowPath) throw new CliInputError("invalid_invocation");
  return {
    command,
    workflowPath,
    ...(values.has("--start-step") ? { startStepId: values.get("--start-step") } : {}),
    ...(values.has("--parameters-file")
      ? { parametersPath: values.get("--parameters-file") }
      : {}),
  };
}

async function readJson(
  path: string,
  dependencies: CliDependencies,
  errorCode: string,
): Promise<unknown> {
  try {
    const content = await dependencies.readFile(path);
    if (content.byteLength > maxInputBytes) throw new Error("oversized");
    return JSON.parse(content.toString("utf8")) as unknown;
  } catch {
    throw new CliInputError(errorCode);
  }
}

function parseParameterValues(input: unknown): Readonly<Record<string, string>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CliInputError("invalid_parameters");
  }
  const entries = Object.entries(input);
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw new CliInputError("invalid_parameters");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new CliInputError("invalid_configuration");
}

function workerConfig(env: NodeJS.ProcessEnv): BrowserbaseWorkerConfig {
  const apiKey = env.BROWSERBASE_API_KEY;
  if (!apiKey?.trim()) throw new CliInputError("invalid_configuration");
  const region = env.BROWSERBASE_REGION ?? "us-west-2";
  if (!regions.has(region as BrowserbaseRegion)) {
    throw new CliInputError("invalid_configuration");
  }
  return {
    apiKey,
    ...(env.BROWSERBASE_PROJECT_ID ? { projectId: env.BROWSERBASE_PROJECT_ID } : {}),
    region: region as BrowserbaseRegion,
    useProxy: parseBoolean(env.BROWSERBASE_USE_PROXY),
    verified: parseBoolean(env.BROWSERBASE_VERIFIED),
  };
}

function exitCodeForOutcome(outcome: BrowserbaseRunOutcome): number {
  if (outcome.status === "completed") return 0;
  if (outcome.status === "timed_out") return 124;
  if (outcome.status === "cancelled") return 130;
  if (outcome.stage === "validation") return 2;
  return 1;
}

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies: CliDependencies = productionDependencies,
): Promise<number> {
  try {
    const options = parseArgs(argv);
    const workflow = await readJson(options.workflowPath, dependencies, "invalid_workflow");
    const parameterValues = options.parametersPath
      ? parseParameterValues(
          await readJson(options.parametersPath, dependencies, "invalid_parameters"),
        )
      : {};

    if (options.command === "validate") {
      const prepared = prepareWorkflow(workflow, options.startStepId, parameterValues);
      writeJson(dependencies, {
        type: "validation.completed",
        status: "completed",
        totalSteps: prepared.preflight.totalSteps,
      });
      return 0;
    }

    const worker = dependencies.createWorker(workerConfig(env));
    const outcome = await worker.run({
      workflow,
      parameterValues,
      ...(options.startStepId ? { startStepId: options.startStepId } : {}),
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      onEvent: (event) => writeJson(dependencies, event),
    });
    writeJson(dependencies, { type: "worker.outcome", ...outcome });
    return exitCodeForOutcome(outcome);
  } catch (error) {
    const code =
      error instanceof WorkerValidationError
        ? error.code
        : error instanceof CliInputError
          ? error.code
          : "invalid_invocation";
    writeJson(dependencies, { type: "validation.failed", status: "failed", code });
    return 2;
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    process.exitCode = await runCli(process.argv.slice(2), process.env, {
      ...productionDependencies,
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void main();
}
