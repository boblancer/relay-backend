# ADR-001: Use PostgreSQL with canonical JSONB workflow documents

## Status

Superseded by ADR-010

## Date

2026-07-30

## Context

The cloud workflow contract writes complete snapshots rather than individual steps. A
successful mutation must atomically compare a revision, persist the new document,
update a privacy-safe list summary, and record the idempotent response. The first
implementation should remain small while behaving correctly under concurrent writers.

## Decision

Use PostgreSQL and direct Psycopg for runtime persistence. Store each complete canonical
workflow in JSONB alongside relational lifecycle columns used for locking, ordering,
and revision checks. Persist a separate safe summary JSONB value and make list queries
select only that value.

Keep idempotency results in a second table. Claim the key, mutate the workflow, and
record the successful response in one transaction. Use Alembic and SQLAlchemy only for
schema migrations.

## Alternatives considered

### SQLite

Simpler installation, but concurrent cloud writers and multiple service processes would
require a storage rewrite. Rejected because transaction correctness is a core contract
requirement rather than a later optimization.

### Fully normalized workflow tables

Would support detailed SQL queries into steps and targets, but the API neither exposes
nor needs those queries. Rejected because it adds mapping and migration complexity to a
whole-document persistence service.

### Runtime ORM

Would map lifecycle columns well but offers little value for opaque workflow JSON and
explicit compare-and-swap transactions. Rejected in favor of short parameterized SQL.

## Consequences

- Local development requires PostgreSQL, provided by Docker Compose.
- Workflow schema changes generally do not require relational migrations.
- The document and summary are duplicated and must always be updated in one transaction.
- List operations are privacy-safe by construction and do not load full documents.
