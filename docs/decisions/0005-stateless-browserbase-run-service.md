# ADR-005: Add a stateless Browserbase run service

## Status

Accepted

## Date

2026-08-02

## Context

ADR 0004 added a reusable Browserbase worker and deliberately deferred its transport.
An internal caller now needs an HTTP boundary for one unattended run without adding a
queue, durable run model, or execution responsibility to the Python persistence API.
Runs can last ten minutes, contain sensitive parameter values, create paid provider
sessions, and perform non-idempotent external actions.

## Decision

Add the independent private ESM package `@relay/automation-service-browserbase`. It is
a Fastify service that imports `@relay/automation-worker-browserbase`, accepts the full
workflow and explicit parameter map at `POST /v1/run`, and keeps no durable state. This
record supersedes ADR 0004 while preserving its provider-worker and automation-core
boundaries.

Authenticate internal callers with a dedicated bearer token. Stream privacy-safe
NDJSON events, 15-second heartbeats, and one terminal outcome under an ephemeral run
ID. Validate before the response stream and paid session; return safe HTTP errors for
preflight, media, authentication, size, and capacity failures. Once streaming begins,
represent provisioning and execution results in the terminal line.

Cancel on client disconnect and process shutdown. Use a configurable per-process
concurrency limit with immediate `429` rejection rather than an in-memory queue.
Provider region, proxy, Verified mode, and deadlines remain operator-controlled. Keep
the FastAPI service, PostgreSQL schema, and persistence OpenAPI contract unchanged.

Do not add schedules, durable jobs, result lookup, reconnection, automatic retries,
idempotency, user authorization, or authenticated browser contexts in this slice.

## Alternatives considered

### Add the route to FastAPI

Rejected because Playwright and the existing worker are TypeScript. Shelling out from a
Python request would couple process supervision and cancellation to the persistence
service, while a second implementation would duplicate workflow semantics.

### Add HTTP transport to the worker package

Rejected because provider lifecycle remains reusable by the CLI and future consumers.
A sibling service keeps authentication, streaming, health, and capacity policy out of
the worker.

### Return one JSON response after completion

Rejected because a silent request can run for ten minutes and is vulnerable to proxy
idle timeouts. NDJSON reuses the worker's safe event model and permits heartbeats.

### Keep disconnected runs alive

Rejected because a stateless caller could not observe or retrieve the result, while the
paid provider session and external side effects would continue.

## Consequences

- Internal callers gain a deployable Node process without changing workflow storage.
- A request cannot reconnect or look up a result after disconnection.
- HTTP status reports only failures known before streaming; terminal lines report later
  outcomes.
- Automatic client or proxy retries can duplicate side effects and must be disabled.
- Per-process concurrency is not a global quota; replica sizing remains an operator
  responsibility until a durable queue is introduced.
- All workflow and parameter values remain request-scoped memory and must be protected
  in transit.
