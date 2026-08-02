# @relay/automation-service-browserbase

Private Fastify service for executing one finalized Relay workflow per authenticated
HTTP request. It imports `@relay/automation-worker-browserbase` directly and has no
dependency on FastAPI or PostgreSQL.

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

Set `BROWSERBASE_API_KEY` and a random service token containing at least 32 bytes, then
start the service:

```bash
export AUTOMATION_SERVICE_TOKEN="$(openssl rand -hex 32)"
npm start --prefix packages/automation-service-browserbase
```

The service reads only process environment variables. It does not load another
repository's `.env.local` or resolve workflows from the persistence API.

## API

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

The workflow must be a complete canonical schema 1.2 document. Provider configuration
cannot be overridden by the request. Successful preflight returns
`application/x-ndjson`; every line contains the response's ephemeral `X-Run-Id`.
Progress events and 15-second heartbeats are followed by exactly one
`worker.outcome` line.

Preflight failures return privacy-safe `422` JSON without provisioning Browserbase.
When local capacity is full, the service returns `429` and `Retry-After`. Provisioning,
execution, cancellation, and timeout outcomes are terminal stream lines because the
stream has already begun with HTTP `200`.

Client disconnect cancels the run and releases its fresh Browserbase session. There is
no result lookup or reconnection because the service stores no run state. Callers must
not automatically retry: browser actions can have external side effects.

`GET /health/live` and `GET /health/ready` do not require authentication. Readiness
returns `503` only while the process is shutting down, not merely while it is at run
capacity.

The authoritative service contract is [`openapi.yaml`](openapi.yaml).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTOMATION_SERVICE_TOKEN` | required | Dedicated bearer token; at least 32 bytes |
| `AUTOMATION_HOST` | `0.0.0.0` | Listen host |
| `PORT` | `8080` | Listen port |
| `AUTOMATION_MAX_CONCURRENT_RUNS` | `1` | Per-process active-run limit |
| `AUTOMATION_RETRY_AFTER_SECONDS` | `1` | `Retry-After` value for capacity rejection |
| `AUTOMATION_RUN_TIMEOUT_MS` | `600000` | Run deadline; maximum 10 minutes |
| `AUTOMATION_STEP_TIMEOUT_MS` | `60000` | Step deadline; maximum 60 seconds |
| `AUTOMATION_SHUTDOWN_GRACE_MS` | `30000` | Cleanup grace after shutdown cancellation |
| `BROWSERBASE_API_KEY` | required | Browserbase credential |
| `BROWSERBASE_PROJECT_ID` | unset | Optional project selection |
| `BROWSERBASE_REGION` | `us-west-2` | Browserbase session region |
| `BROWSERBASE_USE_PROXY` | `false` | Managed proxy opt-in |
| `BROWSERBASE_VERIFIED` | `false` | Verified mode opt-in |

The service disables general Fastify request logging. Its own JSON logs contain only a
generated run ID, fixed lifecycle state, duration, and safe outcome code. Workflow
bodies, URLs, payloads, parameters, authorization headers, Browserbase identifiers,
connection URLs, and raw exceptions never enter responses or logs.

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

This package does not schedule, queue, persist, retry, reconnect, or provide idempotency
for runs. It has no user account or workflow-ownership model and is intended only for a
private network behind TLS. Horizontal replicas must be sized so their combined
per-process capacity does not exceed the Browserbase project limit.
