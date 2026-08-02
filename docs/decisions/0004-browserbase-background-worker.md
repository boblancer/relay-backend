# ADR-004: Add a Browserbase background worker

## Status

Superseded by ADR 0005

## Date

2026-08-02

## Context

ADR 0003 established a provider-neutral TypeScript automation core that accepts a
caller-owned Playwright `Page`. A server-side run still needs a component to validate
run inputs, resolve parameter bindings, create and release a browser session, enforce a
run deadline, and translate setup failures into privacy-safe outcomes.

The first server-side use case targets fresh Browserbase sessions and finalized public
workflows. The persistence API has no queue, run endpoint, run table, profile store, or
credential-vault boundary. Adding those concerns to this first execution slice would
couple browser lifecycle to the Python persistence proof of concept.

## Decision

Add the independent private ESM package `@relay/automation-worker-browserbase`. It
accepts only complete canonical schema 1.2 workflows, resolves recorded and fixed fill
values plus explicit per-step profile/runtime values, provisions a fresh Browserbase
session, and delegates actions to `@relay/automation-core`.

The worker exposes a reusable TypeScript class and a one-run JSONL CLI. It owns
Browserbase configuration, CDP connection, cancellation, deadlines, and best-effort
cleanup. It disables Browserbase recording and logging, never exposes provider session
details, performs no action retries, and does not reuse the workflow's source session.
Proxy and Verified modes are explicit opt-ins.

Keep queues, schedules, HTTP APIs, run persistence, authentication contexts, legacy
workflow migration, and interactive replay controls outside this package. The FastAPI
service and OpenAPI contract remain persistence-only.

## Alternatives considered

### Add Browserbase lifecycle to automation-core

Rejected because it would reverse ADR 0003's provider-neutral boundary and force every
core consumer to depend on one browser provider.

### Execute Browserbase sessions from FastAPI

Rejected because the existing Python service owns workflow persistence and transactional
mutation rules, while the execution implementation and Playwright contract are
TypeScript. Combining them would add process and lifecycle coupling without a run API or
queue design.

### Reuse the interactive recorder runtime

Rejected because it also owns recording, live-view state, manual takeover, tabs, and UI
protocols. Those behaviors are not required by an unattended one-run worker.

## Consequences

- Server callers have a runnable Browserbase path without changing persistence APIs.
- Browserbase SDK and lifecycle changes stay isolated from the provider-neutral core.
- Every run creates a paid, fresh, unauthenticated session and can still be blocked by a
  target site.
- Callers must supply explicit profile/runtime values and protect those values in transit
  and at rest.
- Durable runs, retries, scheduling, authenticated contexts, and legacy inputs require
  separate future decisions.
