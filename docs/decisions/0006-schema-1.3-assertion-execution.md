# ADR-006: Require schema 1.3 for background execution

## Status

Superseded by ADR-012

## Date

2026-08-04

## Context

The recorder now produces canonical workflow schema 1.3 documents. Schema 1.3 adds
visibility and text-containment assertions to the action steps supported by the
provider-neutral automation core. The Browserbase worker and stateless run service
still accepted only schema 1.2, so current recorder workflows failed validation and
could not execute unchanged.

Assertions can contain sensitive expected and observed page text. Background runs also
must not introduce automatic retries because earlier browser actions may have external
side effects. No execution caller requires compatibility with schema 1.0 through 1.2.
The Python persistence contract remains an independent schema 1.2 POC boundary and is
not used by the stateless run service.

## Decision

Require canonical schema 1.3 throughout automation core, the Browserbase worker, its
CLI, and the stateless HTTP and Inngest transports. Reject all earlier versions during
preflight, before creating a paid Browserbase session. Do not normalize or migrate old
execution documents.

Execute assertion steps once in workflow order. A visibility assertion passes only
when locator resolution finds exactly one visible target. A text-containment assertion
reads visible text, collapses whitespace, trims it, compares case-insensitively, and
requires the normalized observed text to contain the normalized expectation. Expected
text must be nonblank and no longer than 1,000 characters. Assertions emit an
`asserting` phase and do not perform post-assertion settling.

Return fixed privacy-safe assertion failures. Never expose expected or observed text,
target or locator values, URLs, workflow bodies, or raw browser errors through events,
outcomes, HTTP responses, or logs.

This record supersedes only the schema-version portions of ADRs 0003, 0004, and 0005.
Their package, provider-lifecycle, transport, cancellation, capacity, and privacy
boundaries remain accepted.

## Alternatives considered

### Continue accepting schema 1.2

Rejected because execution callers no longer require it, and maintaining two canonical
contracts would add branching and tests without serving a current workflow producer.

### Normalize schema 1.2 to 1.3

Rejected because the worker is an executor rather than a migration boundary. Silent
normalization would obscure which contract was actually validated and executed.

### Retry assertions until the step timeout

Rejected because recorder replay semantics evaluate assertions once after the preceding
action settles. Repeated evaluation would make local and background replay disagree and
could conceal a transient incorrect state.

## Consequences

- Current schema 1.3 recorder workflows, including assertions, execute unchanged.
- Schema 1.0 through 1.2 execution requests fail preflight without provider cost.
- Assertion events and failures remain safe to stream and log.
- Callers with older workflow documents must upgrade them before invoking the worker.
- The persistence and execution contracts temporarily use different schema versions and
  remain intentionally decoupled.
