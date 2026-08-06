# Automation Core Replay Parity Refactor

## Objective

Refactor `@relay/automation-core` into focused workflow-contract, target-resolution,
action, and settling responsibilities while matching the non-interactive behavior of
Browser Replay commit `bbf6409ae154dc8980b2b9d36e834c2c3b849182`.

The refactor must preserve the package's provider-neutral API, caller-controlled
Playwright `Page`, cancellation behavior, configurable deadlines, and privacy-safe
diagnostics. Browserbase provisioning and interactive pause/retry/manual-control remain
outside automation core.

## Structure

- `src/workflow.ts`: stable workflow API facade and schema boundary.
- `src/target-resolution.ts`: frame selection, locator construction, uniqueness,
  visibility, and recorded element fingerprint checks.
- `src/step-actions.ts`: canonical action and assertion execution.
- `src/execution.ts`: cancellation, page positioning, settling, waits, and orchestration.
- `src/runner.ts`: sequential run lifecycle and safe events/results.
- `tests/`: behavior and regression coverage.

## Testing strategy

Add failing unit tests before each behavior change, then run the focused core test file.
After each increment, run the complete automation-core suite. At completion, typecheck,
test, and build automation core and its Browserbase worker and service consumers.

## Boundaries

- Always preserve privacy-safe output and prompt cancellation.
- Always retain the current schema 1.3 assertion work already present in the worktree.
- Never expose workflow, target, locator, URL, parameter, or provider values.
- Never add action retries or interactive replay controls to background execution.
- Never move Browserbase proxy/session configuration into automation core.
- Do not change the public package API or OpenAPI contracts in this refactor.

## Success criteria

- Recorded tag/input fingerprints prevent a locator from resolving the wrong element.
- Combobox fills use Browser Replay's focus, clear, and sequential typing behavior.
- Ordinary fills and date fills retain direct Playwright `fill()` behavior.
- Existing action, assertion, settling, wait, cancellation, and privacy tests pass.
- Automation core, the Browserbase worker, and the Browserbase service typecheck, test,
  and build successfully.
- The live workflow remains a manual verification because matching Browserbase proxy
  provisioning is a separate worker concern.

