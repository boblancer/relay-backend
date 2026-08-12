# ADR-011: Scope workflow persistence to organizational namespaces

## Status

Accepted

## Date

2026-08-11

## Context

Workflow persistence needs organizational grouping without changing canonical workflow
documents, object keys, or the shared-authentication POC boundary. Existing callers use
flat workflow routes, and existing idempotency identities include the literal HTTP path.
Migration `0002` already introduced UUID-backed `namespaces` and `records` tables.

## Decision

Every workflow belongs to exactly one namespace in PostgreSQL. Namespace-scoped routes
are canonical in OpenAPI 1.1 and receive the existing workflow operation IDs. The five
flat routes remain deprecated aliases with `legacy...` operation IDs for one compatibility
release. Flat creation uses the exact-case `Default` namespace; other flat operations
retain global workflow-ID behavior. Alias paths remain distinct idempotency identities.

Namespaces organize data but do not authorize it. Names are trimmed, 1–100 characters,
and exact-case unique. The migration refuses invalid existing names, reuses or creates
`Default`, and backfills workflow ownership without rewriting canonical documents or
metadata. Nested lookup failures do not reveal whether the namespace, workflow, or
ownership relation was missing.

## Alternatives considered

### Put namespace metadata in canonical workflow documents

Rejected because organizational ownership is relational metadata and would force object
rewrites while coupling recorder schema to backend organization.

### Normalize flat and nested idempotency identities

Rejected because existing identities explicitly include literal paths. Normalization
would change replay semantics and require ownership-aware migration of stored records.

### Remove flat routes immediately

Rejected to preserve one HTTP compatibility release. Removal is reserved for OpenAPI
2.0 after callers migrate.

## Consequences

- Nested reads and writes constrain both namespace and workflow UUID in SQL.
- List endpoints remain summary-only; namespace operations never access the bucket.
- Rename, deletion, transfer, pagination, and namespace-specific authorization remain
  deferred.
- Regenerated clients see workflow operation IDs move to nested routes in version 1.1.
