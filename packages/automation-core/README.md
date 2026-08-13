# @relay/automation-core

Private, provider-neutral TypeScript automation library for sequential background
execution of Relay workflow documents. The caller owns the browser and
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
Locator resolution also verifies recorded tag and input-type fingerprints before using
a unique visible match. Fill steps recorded against a combobox clear and type
sequentially to preserve the input-event behavior expected by autocomplete controls;
ordinary fills and date inputs continue to use Playwright's direct `fill()` action.

Assertion steps are evaluated once after the preceding action has settled.
`visible` requires one uniquely resolved visible target. `text_contains` applies
case-insensitive, whitespace-normalized containment to the target's visible text.
Assertions emit the `asserting` phase, do not settle afterward, and return only fixed
privacy-safe failure diagnostics. `schemaVersion` is required string metadata but its
value does not affect validation or execution admission.

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
`bbf6409ae154dc8980b2b9d36e834c2c3b849182`. That repository remains the interactive
editor replay product; changes here do not modify it.

Execution is divided internally between target/frame resolution, canonical step
actions, and orchestration/settling. `src/execution.ts` remains the compatibility facade
for the existing internal test and runner imports.

## Deliberate boundaries

This package does not own Browserbase lifecycle, browser creation, queues, schedules,
HTTP or WebSocket APIs, authentication, persistence, retries, recording, interactive
pause/skip/take-control behavior, or monitoring infrastructure. Consumers may map its
events and results onto those facilities without coupling them into the automation
core.
