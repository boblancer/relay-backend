# ADR-003: Add a standalone TypeScript automation core

## Status

Accepted

## Date

2026-07-31

## Context

Relay has two replay concerns. The recorder product provides an interactive,
client-side edit and validation experience. A separate background automation feature
needs to execute the same canonical workflow behavior without interactive controls.
Putting background execution into the Python persistence service would couple browser
lifecycle and automation changes to transaction and API concerns. Copying the entire
interactive replay implementation would also import recording, UI state, Browserbase,
and service infrastructure that a background runner does not need.

The source automation behavior is TypeScript and directly uses Playwright. Keeping the
portable core in TypeScript minimizes semantic translation while retaining strict
contract checks and direct Playwright types.

## Decision

Add a private ESM package at `packages/automation-core`. It validates canonical
workflow schema 1.2 documents, performs preflight selection, executes Playwright actions
sequentially, and returns privacy-safe structured events and terminal results.

The package accepts a caller-owned Playwright `Page`. It does not abstract browser
providers or own Browserbase lifecycle, HTTP/WebSocket transport, jobs, schedules,
authentication, persistence, retries, recording, or interactive pause, skip, and
take-control behavior. It fails fast on the first step error and supports cancellation
through `AbortSignal` at safe phase and polling boundaries.

Keep package dependencies limited to Zod and the Playwright types/runtime peer, with
TypeScript and Vitest as development tools. Keep its lockfile and build independent of
the Python service. The FastAPI application, PostgreSQL persistence, and `openapi.yaml`
remain unchanged.

## Alternatives considered

### Move replay execution into FastAPI

Rejected because Playwright execution, provider lifecycle, and background job concerns
would become coupled to a persistence proof of concept without improving the external
storage contract.

### Extract one shared core inside the interactive recorder repository

Deferred. It could eventually reduce duplication between interactive validation and
background automation, but it requires a broader frontend refactor and risks mixing
interactive state and controls into the first background-runner boundary.

### Port the complete replay feature

Rejected because recording, retries, manual takeover, UI events, and Browserbase
session management are not reusable automation primitives and would enlarge the public
surface without a current consumer need.

### Translate the automation behavior to Python

Rejected because it would require maintaining a second interpretation of the
TypeScript workflow and Playwright behavior while offering no benefit to the standalone
worker boundary.

## Consequences

- Background workers can reuse a small library while choosing their own browser
  provider, queue, transport, and persistence.
- Interactive replay and background automation remain distinct products; behavior
  changes that should stay aligned require explicit tests or later shared ownership.
- The repository now has independent Python and Node.js verification and dependency
  lockfiles.
- Consumers receive structured results and lifecycle events but must implement browser
  creation, monitoring, retries, and durable run records themselves.
- Diagnostics are intentionally less detailed than raw Playwright failures so payloads,
  selectors, URLs, and session identifiers do not cross the library boundary.
