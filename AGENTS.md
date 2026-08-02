# Relay Backend agent guide

Relay Backend is a Python 3.12 FastAPI proof of concept that persists Browser Memory
Recorder workflow documents in PostgreSQL, with separate TypeScript packages for
Browserbase execution and stateless HTTP transport. Before changing the repository, read
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
- Keep canonical documents and privacy-safe summaries synchronized in one transaction.
- Never expose or log workflow bodies, credentials, step payloads, targets, parameter
  values, source session IDs, or persistence details.
- Keep run-service request/header logging disabled; stream exactly one safe terminal
  outcome and abort Browserbase work on disconnect or shutdown.
- List queries must read only safe summaries, not canonical workflow documents.
- Keep runtime SQL parameterized.
- Keep `openapi.yaml`, Pydantic models, controllers, and tests synchronized.
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
