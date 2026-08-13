# @relay/automation-worker-browserbase

Private Node.js worker for executing finalized Relay workflow documents in
fresh Browserbase sessions. It owns Browserbase lifecycle and delegates browser actions
and assertions to `@relay/automation-core`. It does not expose an HTTP API, persist run
state, retry actions, reuse recorded sessions, or manage authentication state.

## Commands

Build the automation core before installing or running this local package dependency:

```bash
npm ci --prefix packages/automation-core
npm run build --prefix packages/automation-core
npm ci --prefix packages/automation-worker-browserbase
npm run build --prefix packages/automation-worker-browserbase
```

Validate a workflow without creating a paid Browserbase session:

```bash
npm --prefix packages/automation-worker-browserbase run cli -- \
  validate --workflow /absolute/path/to/workflow.json
```

Run a workflow:

```bash
export BROWSERBASE_API_KEY=replace-me
npm --prefix packages/automation-worker-browserbase run cli -- \
  run --workflow /absolute/path/to/workflow.json
```

Both commands accept `--start-step <step-id>` and
`--parameters-file /absolute/path/to/parameters.json`. The parameter file is a JSON
object whose keys are fill-step IDs and whose values are the explicit profile/runtime
values for the selected enabled range. Treat it like a secret and do not commit it.

The CLI writes privacy-safe JSON Lines. It never writes workflow bodies, file paths,
URLs, payloads, parameter values, Browserbase session or connection identifiers, or raw
provider errors. Exit codes are `0` for success, `1` for provisioning/execution failure,
`2` for invocation or validation failure, `124` for timeout, and `130` for cancellation.
The required `schemaVersion` string is treated as opaque metadata and does not affect
whether a Browserbase session is created.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BROWSERBASE_API_KEY` | Run only | None | Authenticates Browserbase API calls. |
| `BROWSERBASE_PROJECT_ID` | No | API-key project | Selects a Browserbase project. |
| `BROWSERBASE_REGION` | No | `us-west-2` | Selects a supported Browserbase region. |
| `BROWSERBASE_USE_PROXY` | No | `false` | Opts into Browserbase managed proxy routing. |
| `BROWSERBASE_VERIFIED` | No | `false` | Requests Verified mode when the account supports it. |

Sessions are fresh and unauthenticated. Browserbase capture/logging is disabled,
CAPTCHA solving is enabled, execution is limited to ten minutes, and each step receives
a 60-second timeout. The worker does not retry actions because repeating a click or
submission could duplicate an external side effect.
Assertions execute once, emit the `asserting` phase, and are not retried.

Library callers may supply `onTerminalScreenshot` to receive one best-effort PNG of the
visible viewport after the automation result is known and before browser cleanup. The
capture and callback have a two-second budget and cannot replace the run outcome. The
worker does not store or publish the image; that remains the caller's responsibility.

## Verification

```bash
npm run typecheck --prefix packages/automation-worker-browserbase
npm test --prefix packages/automation-worker-browserbase
npm run build --prefix packages/automation-worker-browserbase
npm pack --dry-run ./packages/automation-worker-browserbase
```

The real Browserbase smoke test is navigation-only and opt-in because it creates a paid
session:

```bash
BROWSERBASE_E2E=1 BROWSERBASE_API_KEY=replace-me \
  npm run test:browserbase --prefix packages/automation-worker-browserbase
```
