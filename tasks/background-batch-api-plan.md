# Backend Plan: In-Memory Background Batch API

- Status: Implemented
- Repository: `relay_backend`
- Owning package: `packages/automation-service-browserbase`
- Related decision: `docs/decisions/0005-stateless-browserbase-run-service.md`

## Objective

Add a small unauthenticated local batch API to the Browserbase automation service so a caller
can submit up to ten complete workflow runs, receive a batch ID immediately, and poll
privacy-safe per-workflow progress until every run is terminal.

The batch API is the background-execution owner. It keeps queued inputs and safe results
in process memory, executes up to five workflows concurrently through the existing
`BrowserbaseAutomationWorker`, and loses all batch state when the process restarts. The
FastAPI persistence service and PostgreSQL remain unchanged.

## Assumptions

1. This is an MVP for one long-running automation-service process, not a distributed
   queue.
2. A batch contains at most ten schema 1.3 workflows and the complete HTTP request must
   remain within the existing 1 MiB request limit.
3. Batch, direct, and Inngest runs share one process-wide concurrency limit that defaults
   to five. Batch runs consume every slot available to them without reserved capacity.
4. Recorded and fixed fill values are the supported caller path. A profile/runtime-bound
   workflow without explicit values becomes a safe per-run validation failure without
   provisioning Browserbase.
5. Batch creation is not automatically retried. Duplicate submissions can produce
   duplicate external side effects, so callers must disable the initiating control after
   the first accepted request.
6. Batch polling returns execution facts only. A client decides whether those facts mean
   its folder operation succeeded.

## Ownership Boundary

```text
POST /v1/batches
        |
        v
in-memory batch coordinator
        |
        +--> queued input held privately
        |
        +--> BrowserbaseAutomationWorker.run() through shared slots
        |
        +--> safe BatchSnapshot retained for polling
        |
        v
GET /v1/batches/{batchId}
```

The batch service owns:

- admission, batch IDs, FIFO queue order, five-slot dispatch, safe status projection,
  retention, and cleanup;
- the lifetime of the full workflow documents after they enter the service; and
- cancellation of active work during service shutdown.

It does not own:

- UI folders or folder success;
- workflow persistence or workflow lookup;
- durable jobs, schedules, retries, notifications, or result history;
- user authorization or multi-tenant isolation; or
- Browserbase Live View, session recording, or interactive replay controls.

## HTTP Contract

### Create a batch

```http
POST /v1/batches
Content-Type: application/json
Accept: application/json
```

```json
{
  "runs": [
    { "workflow": {} },
    { "workflow": {} }
  ]
}
```

MVP request rules:

- `runs` is required and contains between one and ten items.
- Each item has exactly one `workflow` property.
- The workflow body is a complete canonical schema 1.3 document.
- `startStepId` and `parameterValues` are deferred from the batch contract. They remain
  available on the existing single-run API.
- The total request is subject to the existing 1 MiB service body limit.

Accepted response:

```http
202 Accepted
Cache-Control: no-store
```

```json
{
  "batchId": "63a97930-fb37-4f51-b729-40dd97a55df8",
  "runCount": 2
}
```

Creation errors use the service's existing safe error envelope. Required statuses are
`400`, `413`, `415`, `429`, `500`, and `503`. `429` means the configured number
of queued batches has been reached; it never means the caller should automatically
replay browser actions.

### Poll a batch

```http
GET /v1/batches/{batchId}
Accept: application/json
```

```json
{
  "batchId": "63a97930-fb37-4f51-b729-40dd97a55df8",
  "runs": [
    {
      "workflowId": "e0ed53ee-de95-4608-a45a-23dfc23fdc41",
      "status": "completed",
      "currentStep": 3,
      "totalSteps": 3,
      "passedSteps": 3,
      "skippedSteps": 0,
      "durationMs": 12450
    },
    {
      "workflowId": "b8e7a665-b499-4807-a238-264133b202e7",
      "status": "running",
      "currentStep": 2,
      "totalSteps": 5
    }
  ]
}
```

Polling rules:

- Per-run status is exactly `queued`, `running`, `completed`, or `failed`.
- `cancelled` and `timed_out` worker outcomes project to `failed` with a safe fixed code.
- `currentStep` is a completed-step count suitable for progress display, not a step
  payload or locator.
- A failed run may include `failedStepId`, `failedStepIndex`, `phase`, and a fixed safe
  failure code already permitted by the worker result contract.
- Workflow names, workflow bodies, URLs, targets, payloads, parameter values,
  credentials, source session IDs, provider session IDs, connection URLs, and raw
  exceptions are never returned.
- `404` means the batch is unknown or expired.
- Polling is read-only and can never start, retry, or duplicate a run.

## In-Memory State

Use one private coordinator instance per service process:

```ts
type BatchRunStatus = "queued" | "running" | "completed" | "failed";

interface SafeBatchRun {
  workflowId: string;
  status: BatchRunStatus;
  currentStep: number;
  totalSteps: number;
  passedSteps?: number;
  skippedSteps?: number;
  durationMs?: number;
  failedStepId?: string;
  failedStepIndex?: number;
  phase?: "acting" | "settling" | "waiting" | "asserting";
  code?: BatchFailureCode;
}
```

Keep full workflow inputs in a private queue separate from `SafeBatchRun`. Remove an
input as soon as its worker call settles. Retain only the safe snapshot after terminal
completion.

Retention defaults:

- completed batch TTL: one hour;
- maximum retained queued, active, and completed batches: 100; and
- cleanup: opportunistically on create and poll, avoiding a separate scheduler.

If the cap is reached and no expired terminal record can be removed, reject creation
with `429`. Never evict queued or running work to admit a new batch.

## Execution Semantics

1. Structurally validate the request.
2. Allocate the batch record and return `202` before provisioning Browserbase.
3. A FIFO coordinator fills every available shared service slot with queued workflows.
4. Run no more than five total batch, direct, and Inngest workers by default.
5. Map worker events into safe progress:
   - `worker.started` marks the run `running`;
   - `run.started` sets `totalSteps`;
   - `step.completed` advances `currentStep`;
   - `worker.outcome` sets the terminal status and safe result fields.
6. Release the queued workflow object after the worker settles.
7. Continue to the next workflow even when the previous workflow failed.
8. During shutdown, reject new batches, abort the active worker through the existing
   shutdown signal, and stop starting queued work.

The existing `POST /v1/run` behavior remains available. Direct streaming runs retain
immediate capacity rejection. Batch work and direct work must share the same active-run
capacity accounting so they cannot exceed the Browserbase project limit.

## Project Structure

```text
packages/automation-service-browserbase/
├── openapi.yaml
├── README.md
├── src/
│   ├── app.ts
│   ├── config.ts
│   ├── batches/
│   │   └── batch-coordinator.ts
│   └── main.ts
└── tests/
    ├── batches.test.ts
    ├── lifecycle.test.ts
    ├── integration.test.ts
    └── fixtures.ts
```

Keep HTTP serialization and media negotiation in `app.ts`, while the one small coordinator
module stays independent of Fastify.

## Code Style

Use strict explicit unions and return new privacy-safe projections rather than exposing
internal records:

```ts
export function batchSnapshot(record: BatchRecord): BatchSnapshot {
  return {
    batchId: record.batchId,
    runs: record.runs.map((run) => explicitSafeRunProjection(run)),
  };
}
```

Follow the package's existing ESM imports, strict TypeScript settings, safe fixed error
messages, dependency injection for tests, and no general request logging.

## Implementation Order

1. Write ADR 0007 to supersede only ADR 0005's strictly stateless/no-result-lookup
   portions. Preserve the worker, privacy, no-retry, and provider lifecycle decisions.
   ADR 0008 later supersedes its authentication decision for the local POC.
2. Add failing coordinator tests for FIFO order, shared five-slot execution, progress
   projection, failure continuation, retention, capacity, and input release.
3. Implement `batch-coordinator.ts` without Fastify dependencies.
4. Add failing HTTP contract tests for unauthenticated access, request limits, `202`, polling,
   safe `404`, and privacy.
5. Register the two routes and share capacity/shutdown behavior with direct runs.
6. Update OpenAPI, README, and NAVIGATION for the in-memory batch boundary.
7. Add integration coverage using the real worker with fake Browserbase dependencies.
8. Run static, test, build, package, and OpenAPI verification.

## Testing Strategy

Unit tests prove:

- FIFO batch and run order;
- no more than the available shared slots active at a time;
- a failed run does not stop later runs;
- polling is a pure snapshot and never invokes the worker;
- terminal outcomes map to safe statuses and fields;
- full inputs are released after each terminal result;
- TTL/cap behavior never evicts active work; and
- shutdown prevents new work and aborts the active worker.

HTTP tests prove:

- create and poll work without authorization headers;
- strict request shapes and one-to-ten run limits;
- `202` returns before a pending worker resolves;
- `404` does not reveal whether an ID once existed;
- response bodies and logs contain no protected workflow/provider data; and
- batch and direct runs share capacity correctly.

Integration tests use provider fakes. The existing opt-in paid navigation smoke test is
not expanded to run ten sessions.

## Commands

```bash
npm run typecheck --prefix packages/automation-service-browserbase
npm test --prefix packages/automation-service-browserbase
npm run build --prefix packages/automation-service-browserbase
npm pack --dry-run ./packages/automation-service-browserbase
uv run python -m openapi_spec_validator packages/automation-service-browserbase/openapi.yaml
```

## Boundaries

Always:

- validate before each paid Browserbase provisioning attempt;
- stream nothing from the original workflow into polling or logs;
- execute each accepted workflow at most once;
- share concurrency and shutdown cancellation with direct runs; and
- update OpenAPI, tests, README, NAVIGATION, and the architectural record together.

Ask first:

- adding PostgreSQL or another durable store;
- accepting batches larger than ten or requests larger than 1 MiB;
- adding automatic retries, scheduling, or cancellation endpoints;
- exposing workflow names or captured website output; or
- changing the existing direct-run API.

Never:

- log workflow inputs, parameters, URLs, locators, or provider identifiers;
- retry a browser action automatically;
- evict active work to make room for a new batch;
- expose the Browserbase connection URL or session identifier; or
- make the FastAPI persistence service own Browserbase execution.

## Success Criteria

- A valid six-workflow request returns `202` and a batch ID before any run finishes.
- Polling shows five runs progressing while the sixth remains queued at default capacity.
- Exactly six fresh Browserbase worker runs occur, with no more than five active together.
- After two completed worker outcomes, polling reports both runs `completed` with safe
  counts and durations.
- If one run fails, its safe failure is retained and the next queued run still runs.
- Repeated polling never creates an additional worker call.
- No protected workflow or provider data enters responses or logs.
- Existing `POST /v1/run`, health, shutdown, and Inngest behavior remains passing.

## Open Questions

None required for this MVP. Durable storage, cancellation, parameterized batch inputs,
and idempotent batch creation are explicitly deferred and require a new review.
