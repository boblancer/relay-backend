# @relay/automation-core

Private, provider-neutral TypeScript automation library for sequential background
execution of Relay workflow schema 1.2 documents. The caller owns the browser and
passes an existing Playwright `Page`; this package does not create browser sessions,
persist runs, or expose a service API.

## Usage

```ts
import { AutomationRunner, preflightAutomation } from "@relay/automation-core";
import type { Page } from "playwright-core";

export async function runWorkflow(page: Page, document: unknown, signal?: AbortSignal) {
  const automation = preflightAutomation(document);
  const runner = new AutomationRunner(page, {
    signal,
    stepTimeoutMs: 60_000,
    onEvent: (event) => {
      // Forward privacy-safe lifecycle events to the caller's transport or monitor.
      console.info(event.type);
    },
  });

  return runner.run(automation);
}
```

`preflightAutomation(document, startStepId?)` validates the canonical contract, rejects
duplicate step IDs and empty enabled ranges, selects the starting index, and chooses a
bootstrap URL when the first enabled step is not a navigation.

`AutomationRunner` executes the selected range in workflow array order. It skips
disabled steps and redundant recorded option clicks, stops at the first failure, and
returns a `completed`, `failed`, or `cancelled` result. Its event and result diagnostics
contain step IDs, phases, locator kinds, and generic reasons only; they exclude action
payloads, target values, locator values, URLs, workflow bodies, and source session IDs.

`AutomationRunnerOptions.stepTimeoutMs` controls navigation, locator, action, and wait
deadlines. It defaults to 15 seconds; remote consumers can select a longer deadline.

## Development

Requires Node.js 24 or newer.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The port is behavior-derived from `browser_replay` commit
`feec00d34ee55064931d105ec72b3d54a7b98bbb`. That repository remains the interactive
editor replay product; changes here do not modify it.

## Deliberate boundaries

This package does not own Browserbase lifecycle, browser creation, queues, schedules,
HTTP or WebSocket APIs, authentication, persistence, retries, recording, interactive
pause/skip/take-control behavior, or monitoring infrastructure. Consumers may map its
events and results onto those facilities without coupling them into the automation
core.
