# ADR-012: Treat execution schema versions as opaque metadata

## Status

Accepted

## Date

2026-08-12

## Context

The execution stack previously admitted only schema 1.3 workflow documents. Recorder
schema versions can advance independently of the Browserbase execution service, and a
version-only gate rejects otherwise executable documents before structural validation.
The Python persistence API remains an independent, server-owned schema 1.2 boundary.

## Decision

Require `schemaVersion` to be present as a string throughout automation core, the
Browserbase worker, its CLI, and the direct, batch, and Inngest transports. Treat its
contents as opaque metadata and do not use the value to admit or reject a run.

Continue validating the complete executable document shape, completion status, step
variants, parameter bindings, preflight selection, and privacy constraints. Unknown or
older version labels do not relax those checks and do not trigger normalization.

This record supersedes ADR-006 only where it pins execution admission to schema 1.3.
ADR-006's assertion behavior, no-retry rule, and privacy requirements remain accepted.

## Alternatives considered

### Pin execution to schema 1.4

Rejected because each recorder version bump would require a coordinated execution
deployment even when the executable document shape is unchanged.

### Remove schemaVersion from execution documents

Rejected because callers still provide useful provenance metadata and the canonical
document shape requires the field.

## Consequences

- Any string schema-version label can reach structural validation and execution.
- Unsupported document shapes still fail safely before provider provisioning.
- The execution stack cannot use the version label alone to reject a future breaking
  schema; structural validators must reject incompatible fields or variants.
- Persistence and execution remain intentionally decoupled.
