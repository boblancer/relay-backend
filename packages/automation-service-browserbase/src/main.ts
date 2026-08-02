#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { buildAutomationService } from "./app.js";
import { ConfigurationError, loadServiceConfig } from "./config.js";

function writeSafeError(code: string): void {
  process.stderr.write(`${JSON.stringify({ event: "service.failed", code })}\n`);
}

export async function startService(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  let config;
  try {
    config = loadServiceConfig(environment);
  } catch (error) {
    writeSafeError(error instanceof ConfigurationError ? error.code : "invalid_configuration");
    process.exitCode = 2;
    return;
  }

  const service = buildAutomationService(config);
  try {
    await service.app.listen({ host: config.host, port: config.port });
  } catch {
    writeSafeError("startup_failed");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify({ event: "service.started" })}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service
      .shutdown()
      .then(() => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      })
      .catch(() => {
        writeSafeError("shutdown_failed");
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void startService();
}
