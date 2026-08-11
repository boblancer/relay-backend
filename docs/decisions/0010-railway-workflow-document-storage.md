# ADR-010: Store canonical workflow documents in a Railway bucket

## Status

Accepted; supersedes ADR-001

## Date

2026-08-10

## Context

Canonical workflows are opaque documents of up to 1 MiB that can contain credentials,
targets, payloads, and other sensitive values. PostgreSQL must continue to provide the
atomic revision comparison, privacy-safe list summaries, and global idempotency behavior,
but it no longer needs to retain every canonical document in JSONB. Production runs on
Railway, which provides private S3-compatible Storage Buckets.

PostgreSQL and S3 cannot participate in one physical transaction. The design therefore
needs one authoritative visibility boundary and a safe outcome when an object write
succeeds but the relational mutation rolls back.

## Decision

Store canonical workflow documents as deterministic JSON in a private Railway Storage
Bucket. Use immutable content-addressed keys containing workflow ID, revision, and the
document SHA-256 digest. PostgreSQL stores lifecycle metadata, the privacy-safe summary,
and the opaque key of the active object.

Constructor-inject a synchronous `WorkflowDocumentStore` into `WorkflowService`. The
production adapter uses Railway's S3-compatible credentials; tests use an in-memory fake.
Keep bucket I/O inside the existing mutation transaction after idempotency replay and
revision checks. The PostgreSQL commit that updates the document pointer, summary,
revision, and idempotency result is the visibility boundary. A failed transaction can
leave an unreachable immutable object, but it cannot publish a partial workflow mutation.

Migrate existing data in stages. Add a nullable object key and temporarily retain nullable
legacy JSONB. New mutations publish object keys and clear JSONB. A resumable backfill
uploads legacy documents and conditionally publishes their keys without changing workflow
metadata. Drop the legacy column only in a later change after production verification.

## Alternatives considered

### Continue storing canonical JSONB in PostgreSQL

Preserves a single transaction but keeps opaque sensitive documents coupled to relational
storage. Rejected because the deployment requires managed object persistence.

### Railway Volume

Provides a mounted filesystem but couples storage to one service instance and constrains
replication and deployment overlap. Rejected in favor of Railway's private object store.

### Upload mutable files through new HTTP endpoints

Adds a second persistence API and client-controlled filenames without moving the canonical
workflow backing store. Rejected because the existing workflow contract should remain
unchanged.

## Consequences

- Bucket availability is now required for workflow detail reads and mutations; safe
  connectivity failures return `503`.
- List operations remain PostgreSQL-only and never read canonical objects.
- Mutation transactions include bounded network I/O and can hold row locks longer.
- Rolled-back writes may leave unreachable content-addressed objects for later cleanup.
- Object keys and credentials are internal persistence details and must never be exposed
  or logged.
- Migration rollback is refused after a workflow depends solely on an object key.
