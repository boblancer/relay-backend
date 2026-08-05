# ADR-007: Add in-memory background batches

## Status

Accepted

## Date

2026-08-04

## Context

ADR 0005 deliberately made `POST /v1/run` stateless and cancelled work when its
streaming caller disconnected. A POC caller now needs to submit a small group of
complete workflows, return immediately, and poll progress while the service continues
running them. The workflows may contain sensitive values and non-idempotent browser
actions, while a durable queue and multi-tenant authorization remain out of scope.

The Browserbase project also has a finite session allowance. Direct HTTP, local Inngest,
and batch work must not each maintain an independent concurrency counter that can exceed
that allowance.

## Decision

Add authenticated `POST /v1/batches` and `GET /v1/batches/{batchId}` operations to
`@relay/automation-service-browserbase`. Accept one to ten complete schema 1.3 workflow
documents per batch. Keep queued inputs and privacy-safe polling snapshots only in the
service process; retain at most 100 batches and expire terminal snapshots after one
hour.

Dispatch batch runs FIFO whenever shared capacity is available. Batch, direct HTTP, and
local Inngest work use the same configurable active-run limit, which defaults to five.
Direct and Inngest admission remains immediate and returns capacity failure rather than
joining the batch queue. Continue after an individual batch run fails.

Return polling snapshots through an explicit safe-field projection. Never return or log
workflow bodies, names, URLs, targets, payloads, parameter values, source or provider
session identifiers, connection URLs, or raw exceptions. Release each queued workflow
reference after its worker call settles.

On shutdown, reject new batches, discard queued inputs, abort active work through the
existing managed-run signals, and start nothing else. Do not retry runs automatically.
An accepted workflow may run zero or one time because process termination can lose
queued or active state. Callers must not automatically retry uncertain batch creation.

This record supersedes only ADR 0005's no-queue and no-result-lookup decisions. ADR
0005's package boundary, authentication, direct streaming behavior, provider lifecycle,
privacy, cancellation, and no-retry decisions remain accepted. The FastAPI service,
PostgreSQL schema, and persistence contract remain unchanged.

## Alternatives considered

### Add durable jobs to PostgreSQL

Rejected for this POC because durable leasing, recovery, idempotency, retention, and
cross-process capacity would materially expand the persistence service's responsibility.

### Use separate capacity for batches

Rejected because five batch workers plus direct or Inngest work could exceed the
Browserbase project allowance. One process-wide limit is simpler and safer.

### Add batch options and cancellation

Rejected for the first slice. Batch `startStepId`, parameter maps, retries, cancellation
endpoints, schedules, and notifications require separate contracts and review.

## Consequences

- Small background batches can outlive the submission request and expose safe progress.
- Five workflows can run concurrently by default without exceeding the process limit.
- Process restart loses all queued work and polling history.
- Recent terminal snapshots consume the fixed 100-batch retention cap until expiry.
- Horizontal replicas still need operator sizing because the capacity limit is not
  coordinated across processes.
- Automatic submission retries can duplicate external side effects and remain forbidden.
