# @relay/automation-service-browserbase

Local Fastify POC for executing finalized Relay workflows through unauthenticated
streaming and process-local batch APIs, plus an opt-in local Inngest POC. It imports
`@relay/automation-worker-browserbase` directly and has no dependency on FastAPI or
PostgreSQL.

## Setup

Build the local dependencies before installing this package:

```bash
npm ci --prefix packages/automation-core
npm run build --prefix packages/automation-core
npm ci --prefix packages/automation-worker-browserbase
npm run build --prefix packages/automation-worker-browserbase
npm ci --prefix packages/automation-service-browserbase
npm run build --prefix packages/automation-service-browserbase
```

Set `BROWSERBASE_API_KEY`, then start the service:

```bash
npm start --prefix packages/automation-service-browserbase
```

The service reads only process environment variables. It does not load another
repository's `.env.local` or resolve workflows from the persistence API.

From the repository root, a one-line local development start using the ignored `.env`
file is:

```bash
set -a; source .env; set +a; npm run dev --prefix packages/automation-service-browserbase
```

## API

Frontend/BFF callers should omit `Authorization`. Send `Content-Type: application/json`
for both POST routes, request `application/x-ndjson` from `/v1/run`, and request
`application/json` from batch routes. Browser clients should use an existing same-origin
development proxy because this service does not add a public CORS boundary.

`POST /v1/run` accepts:

```json
{
  "workflow": {},
  "startStepId": "optional-step-id",
  "parameterValues": {
    "fill-step-id": "runtime value"
  }
}
```

The workflow must be a complete canonical schema 1.3 document. Earlier schema versions
are rejected before Browserbase provisioning. Provider configuration
cannot be overridden by the request. Successful preflight returns
`application/x-ndjson`; every line contains the response's ephemeral `X-Run-Id`.
Progress events and 15-second heartbeats are followed by exactly one
`worker.outcome` line. When terminal screenshot capture succeeds, that line also
contains a relative `thumbnail` URL and fixed WebP metadata.

Schema 1.3 action and assertion steps run in workflow order. Assertion failures use the
same safe scalar terminal fields as other execution failures and never expose expected
or observed page text. Optional thumbnail metadata is a separate sensitive capability.

Preflight failures return privacy-safe `422` JSON without provisioning Browserbase.
When local capacity is full, the service returns `429` and `Retry-After`. Provisioning,
execution, cancellation, and timeout outcomes are terminal stream lines because the
stream has already begun with HTTP `200`.

Client disconnect cancels the run and releases its fresh Browserbase session. There is
no direct-run result lookup or reconnection. Callers must not automatically retry:
browser actions can have external side effects.

### In-memory batches

`POST /v1/batches` accepts one to ten complete workflows without `startStepId` or
`parameterValues`:

```json
{
  "runs": [
    { "workflow": {} },
    { "workflow": {} }
  ]
}
```

The service returns `202` with a batch ID and runs queued workflows FIFO whenever one
of the process's five default run slots is available. Batch, direct, and Inngest work
share the same configured limit. Direct and Inngest requests still receive immediate
capacity rejection instead of joining the batch queue.

`GET /v1/batches/{batchId}` returns workflow IDs, safe statuses, numeric progress,
durations, fixed failure fields, and optional sensitive terminal `thumbnail` metadata.
Completed and skipped steps both advance `currentStep`. Workflow documents, browser
URLs, targets, values, provider identifiers, raw errors, image bytes, and local paths
are never returned.

### Terminal screenshot artifacts

Direct and batch runs capture the visible viewport after execution reaches a terminal
outcome and before Browserbase cleanup. Capture, conversion, and storage are
best-effort and have a two-second budget; failure only omits `thumbnail` and never
changes the automation outcome.

The service writes compressed WebP files with opaque UUID names under
`.relay/artifacts/` in the repository root by default. Thumbnails are at most 480 by
300 pixels and 100 KiB. Files are not deleted automatically and require manual operator
cleanup.

`GET /v1/artifacts/{artifactId}` serves an allowlisted image for one hour with
`Cache-Control: no-store`. The allowlist exists only in memory: URL expiry or restart
returns `404`, while the file remains on disk for local inspection. Artifact URLs and
IDs are sensitive and never enter service logs. The local Inngest adapter does not
capture screenshots.

Batch state is process-local. Up to 100 batches are retained, terminal batches expire
after one hour, and all state is lost on restart. Accepted workflows may therefore run
zero or one time. Do not automatically retry an uncertain submission because a retry
can duplicate external side effects.

No Relay HTTP endpoint requires an `Authorization` header. The service defaults to
`127.0.0.1`; do not expose this unauthenticated POC publicly. `GET /health/live` and
`GET /health/ready` report process health. Readiness
returns `503` only while the process is shutting down, not merely while it is at run
capacity.

The authoritative service contract is [`openapi.yaml`](openapi.yaml).

## Local Inngest POC

Set `INNGEST_DEV=1` to add the SDK-owned `/api/inngest` endpoint to the existing
Fastify listener. This local-only POC registers one `browserbase-automation-run`
function for `relay/automation.run.requested` events. It uses the same worker, local
capacity, timeout, and shutdown cancellation as `POST /v1/run`, but returns only a safe
terminal outcome to Inngest.

Start the service in development mode:

```bash
export BROWSERBASE_API_KEY="your-browserbase-api-key"
export AUTOMATION_HOST="127.0.0.1"
export INNGEST_DEV=1
npm run dev --prefix packages/automation-service-browserbase
```

In a second terminal, start the local Dev Server:

```bash
npx inngest-cli@latest dev -u http://localhost:8080/api/inngest
```

Open the local Inngest UI, select `browserbase-automation-run`, choose **Invoke**, and
provide `workflow`, optional `startStepId`, and optional string-valued
`parameterValues`. The Dev Server displays event bodies, so use only synthetic
workflows and non-sensitive parameter values. No Inngest account or key is required.
Cloud deployment, payload encryption, scheduling, status lookup, and automatic retries
are outside this POC.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTOMATION_HOST` | `127.0.0.1` | Listen host; non-loopback requires screenshots disabled and remains unsafe for this unauthenticated POC |
| `PORT` | `8080` | Listen port |
| `AUTOMATION_MAX_CONCURRENT_RUNS` | `5` | Shared per-process active-run limit |
| `AUTOMATION_RETRY_AFTER_SECONDS` | `1` | `Retry-After` value for capacity rejection |
| `AUTOMATION_RUN_TIMEOUT_MS` | `600000` | Run deadline; maximum 10 minutes |
| `AUTOMATION_STEP_TIMEOUT_MS` | `60000` | Step deadline; maximum 60 seconds |
| `AUTOMATION_SHUTDOWN_GRACE_MS` | `30000` | Cleanup grace after shutdown cancellation |
| `AUTOMATION_SCREENSHOTS` | `true` | Set to `false` to disable terminal capture and artifact serving; enabled mode requires loopback |
| `AUTOMATION_ARTIFACT_DIR` | repository `.relay/artifacts` | Persistent local screenshot directory |
| `BROWSERBASE_API_KEY` | required | Browserbase credential |
| `BROWSERBASE_PROJECT_ID` | unset | Optional project selection |
| `BROWSERBASE_REGION` | `us-west-2` | Browserbase session region |
| `BROWSERBASE_USE_PROXY` | `false` | Managed proxy opt-in |
| `BROWSERBASE_VERIFIED` | `false` | Verified mode opt-in |
| `INNGEST_DEV` | unset | Set exactly `1` to register the local `/api/inngest` POC endpoint; requires a loopback host |

The service disables general Fastify request logging. Its own JSON logs contain only a
generated run ID, fixed lifecycle state, duration, and safe outcome code. Direct runs
also emit `run.step` records with the numeric step index, fixed status, and optional
fixed phase or skip reason and numeric duration. Workflow bodies, step IDs, URLs,
targets, payloads, parameters, diagnostics, request headers, Browserbase identifiers,
connection URLs, and raw exceptions never enter logs.
Artifact IDs, artifact URLs, image bytes, and local artifact paths also never enter
logs.

## Verification

```bash
npm run typecheck --prefix packages/automation-service-browserbase
npm test --prefix packages/automation-service-browserbase
npm run build --prefix packages/automation-service-browserbase
npm pack --dry-run ./packages/automation-service-browserbase
```

Normal tests use fake Browserbase and Playwright dependencies. A paid navigation-only
HTTP smoke test is explicitly opt-in:

```bash
BROWSERBASE_E2E=1 npm run test:browserbase --prefix packages/automation-service-browserbase
```

## Deliberate boundaries

This package has one bounded process-local batch queue, but does not schedule, persist
run state, retry, reconnect, or provide idempotency for runs. Terminal screenshot files
are the sole persistent local artifacts and are not durable API state. It has no user
account, workflow-ownership, or authentication model and is intended only for loopback use.
It is not safe to expose publicly.
Horizontal replicas must be sized so their combined per-process capacity does not
exceed the Browserbase project limit.
