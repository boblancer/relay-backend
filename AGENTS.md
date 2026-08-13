# Relay Backend agent guide

Relay Backend is a Python 3.12 FastAPI proof of concept that persists Browser Memory
Recorder workflow documents in a private S3-compatible bucket and their metadata in
PostgreSQL and proxies authenticated UUID-based direct runs to separate TypeScript packages for
Browserbase execution and unauthenticated loopback streaming/in-memory batch HTTP transport. Before
changing the repository, read
[`NAVIGATION.md`](NAVIGATION.md); it is the canonical architecture, ownership, and file
structure guide.

## Source-of-truth order

Resolve discrepancies in this order:

1. [`openapi.yaml`](openapi.yaml) for the persistence contract, and
   [`packages/automation-service-browserbase/openapi.yaml`](packages/automation-service-browserbase/openapi.yaml)
   for the independent run-service contract.
2. Runtime code under [`src/relay_backend/`](src/relay_backend/).
3. Executable behavior under [`tests/`](tests/).
4. Accepted rationale under [`docs/decisions/`](docs/decisions/).
5. Explanatory documents, including this file, `NAVIGATION.md`, and `README.md`.

Update the explanatory documents whenever an architectural responsibility, invariant,
setup step, or file location changes.

## Non-negotiable guardrails

- Preserve atomic revision comparison and mutation behavior.
- Increment revisions exactly once for successful new mutations.
- Keep idempotency keys global: exact replays return the original result, conflicting
  reuse returns `409`, and failed mutations do not consume keys.
- Keep every workflow owned by one namespace. Nested access must constrain both UUIDs
  and return the same safe `404` for missing or cross-namespace resources.
- Publish immutable canonical documents before atomically updating their PostgreSQL
  pointer, privacy-safe summary, revision, and idempotency result. A rolled-back
  mutation may leave only an unreachable object.
- Never expose or log workflow bodies, credentials, step payloads, targets, parameter
  values, source session IDs, or persistence details.
- Keep run-service request/header logging disabled; keep its default bind address on
  loopback; stream exactly one terminal outcome with safe scalar fields and abort
  Browserbase work on disconnect or shutdown. The unauthenticated POC must not be
  exposed publicly.
- Keep batch polling progress fields privacy-safe. Treat optional terminal thumbnail
  metadata as sensitive: expose only an opaque temporary loopback URL and fixed image
  metadata, never bytes or local paths, and never log artifact IDs or URLs. Enforce
  shared process-wide run capacity and never start queued batch work after shutdown.
- List queries must read only safe summaries, not canonical workflow documents.
- Keep runtime SQL parameterized.
- Keep `openapi.yaml`, Pydantic models, controllers, and tests synchronized.
- Keep the UUID run gateway streaming and non-retrying. Never log run bodies, parameter
  values, artifact IDs, or artifact URLs; close upstream work when the caller disconnects.
- Add a sequential ADR under [`docs/decisions/`](docs/decisions/) when changing a
  costly-to-reverse architectural decision; supersede rather than delete old ADRs.

## Setup and verification

Use the setup steps in [`README.md`](README.md). The standard checks are:

```bash
uv lock --check
uv run ruff check src tests migrations
uv run ruff format --check src tests
uv run pytest
uv run python -m openapi_spec_validator openapi.yaml
npm run typecheck --prefix packages/automation-service-browserbase
npm test --prefix packages/automation-service-browserbase
npm run build --prefix packages/automation-service-browserbase
uv run python -m openapi_spec_validator packages/automation-service-browserbase/openapi.yaml
```

Tests require PostgreSQL. They use `TEST_DATABASE_URL` when present and otherwise use
the local Compose database. Do not commit `.env` files or secrets.
