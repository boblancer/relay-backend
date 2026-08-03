# Relay Backend

Local proof-of-concept persistence backend for Browser Memory Recorder's canonical
workflow documents, plus provider-neutral automation, a Browserbase worker, and a
stateless internal run service.
The FastAPI service implements the repository's `openapi.yaml`, including atomic
revisions, global idempotency, privacy-safe summaries, and shared HTTP Basic
authentication. It does not execute workflows.

## Quick start

Requirements:

- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/)
- Docker with Compose
- Node.js 24 or newer for automation packages

```bash
cp .env.example .env
uv sync --extra dev
docker compose up -d --wait postgres
set -a
source .env
set +a
uv run alembic upgrade head
uv run uvicorn relay_backend.main:app --reload
```

The API is available at `http://127.0.0.1:8000`. Interactive documentation is at
`http://127.0.0.1:8000/docs`, and the authoritative contract is served from
`http://127.0.0.1:8000/openapi.json`.

Create a draft using a fresh UUID for the logical mutation:

```bash
curl \
  --user "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" \
  --header "Idempotency-Key: $(python -c 'import uuid; print(uuid.uuid4())')" \
  --request POST \
  http://127.0.0.1:8000/v1/workflows
```

## Commands

| Command | Purpose |
| --- | --- |
| `docker compose up -d --wait postgres` | Start local PostgreSQL |
| `uv run alembic upgrade head` | Apply database migrations |
| `uv run uvicorn relay_backend.main:app --reload` | Start the API |
| `uv run pytest` | Run unit, contract, API, and PostgreSQL integration tests |
| `uv run ruff check src tests migrations` | Lint Python code |
| `uv run ruff format --check src tests` | Verify formatting |
| `npm ci --prefix packages/automation-core` | Install the automation library's locked dependencies |
| `npm test --prefix packages/automation-core` | Run automation contract and execution tests |
| `npm run build --prefix packages/automation-core` | Build the TypeScript library and declarations |
| `npm ci --prefix packages/automation-worker-browserbase` | Install the Browserbase worker's locked dependencies after building automation-core |
| `npm test --prefix packages/automation-worker-browserbase` | Run Browserbase worker tests without creating paid sessions |
| `npm run build --prefix packages/automation-worker-browserbase` | Build the Browserbase worker library and CLI |
| `npm ci --prefix packages/automation-service-browserbase` | Install the stateless run service's locked dependencies after building the worker |
| `npm test --prefix packages/automation-service-browserbase` | Run HTTP, lifecycle, integration, and privacy tests without paid sessions |
| `npm run build --prefix packages/automation-service-browserbase` | Build the Fastify service and declarations |
| `npm start --prefix packages/automation-service-browserbase` | Start the stateless run service |

Tests use `TEST_DATABASE_URL` when set and otherwise use the local Compose database.
They truncate only the `workflows` and `idempotency_records` tables between cases.

To remove the local POC database and all of its workflow data:

```bash
docker compose down --volumes
```

## Configuration

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Psycopg PostgreSQL connection URL |
| `BASIC_AUTH_USERNAME` | Shared HTTP Basic username |
| `BASIC_AUTH_PASSWORD` | Shared HTTP Basic password |
| `TEST_DATABASE_URL` | Optional PostgreSQL URL used by tests |
| `BROWSERBASE_API_KEY` | Browserbase worker credential; required only for real runs |
| `BROWSERBASE_PROJECT_ID` | Optional Browserbase project selection |
| `BROWSERBASE_REGION` | Browserbase session region; defaults to `us-west-2` |
| `BROWSERBASE_USE_PROXY` | Opt into managed proxy routing; defaults to `false` |
| `BROWSERBASE_VERIFIED` | Request Verified mode; defaults to `false` |
| `AUTOMATION_SERVICE_TOKEN` | Dedicated run-service bearer token; at least 32 bytes |
| `AUTOMATION_HOST` / `PORT` | Run-service listen address; defaults to `0.0.0.0:8080` |
| `AUTOMATION_MAX_CONCURRENT_RUNS` | Per-process run capacity; defaults to `1` |
| `AUTOMATION_RETRY_AFTER_SECONDS` | Capacity response delay hint; defaults to `1` |
| `AUTOMATION_RUN_TIMEOUT_MS` | Run deadline, at most 10 minutes; defaults to `600000` |
| `AUTOMATION_STEP_TIMEOUT_MS` | Step deadline, at most 60 seconds; defaults to `60000` |
| `AUTOMATION_SHUTDOWN_GRACE_MS` | Cancellation cleanup grace; defaults to `30000` |
| `INNGEST_DEV` | Set exactly `1` with a loopback `AUTOMATION_HOST` to enable the local-only Inngest POC endpoint |

No credentials are built into the application. Copy `.env.example` to the ignored
`.env` file and replace the example password.

## Architecture

The code uses explicit layers without framework-heavy abstractions:

```text
Controller → Service → Data repository → PostgreSQL
                 ↓
            Pydantic models
```

- Controllers translate HTTP requests and responses only.
- The service owns lifecycle, revision, canonicalization, and idempotency behavior.
- The data layer owns parameterized SQL and transaction boundaries.
- PostgreSQL stores the canonical document and a separate safe summary. List queries
  select only the summary and cannot accidentally return payloads or session IDs.
- Alembic uses SQLAlchemy for migrations; runtime queries use Psycopg directly.

[`packages/automation-core`](packages/automation-core/README.md) is an independent ESM
library. A background runner supplies an existing Playwright `Page`, receives
transport-neutral events and structured results, and remains responsible for browser
lifecycle and any persistence. The package has no dependency on FastAPI, PostgreSQL,
Browserbase, or the service's internal persistence model.

[`packages/automation-worker-browserbase`](packages/automation-worker-browserbase/README.md)
is the provider-specific server consumer. It validates complete schema 1.2 workflows,
resolves explicit run parameters, owns fresh Browserbase session lifecycle, and returns
privacy-safe events and outcomes. It does not add an execution route to FastAPI or
persist run state.

[`packages/automation-service-browserbase`](packages/automation-service-browserbase/README.md)
is a separate Fastify process exposing authenticated `POST /v1/run`. Each request
carries a full workflow and explicit parameter values and receives privacy-safe NDJSON
events plus one terminal outcome. Client disconnect cancels the run. The process does
not call the persistence API, use PostgreSQL, or retain run state. An opt-in local
Inngest Dev Server function reuses the same worker, capacity, and shutdown lifecycle for
synthetic POC events without changing the caller-facing OpenAPI contract.

Successful idempotency records are retained indefinitely. A replay with the same key,
method, path, and validated canonical JSON returns the original response even if the
workflow has since changed. Different content returns `409 idempotency_conflict`.

See [ADR 0001](docs/decisions/0001-postgresql-jsonb-persistence.md) and
[ADR 0002](docs/decisions/0002-shared-basic-authentication.md) for the POC tradeoffs.
See [ADR 0003](docs/decisions/0003-standalone-typescript-automation-core.md) for the
automation-library boundary.
See [ADR 0004](docs/decisions/0004-browserbase-background-worker.md) for the Browserbase
worker's original boundary. See
[ADR 0005](docs/decisions/0005-stateless-browserbase-run-service.md) for the superseding
stateless HTTP service decision.

## POC boundaries

The FastAPI service intentionally excludes user accounts, tenants, pagination,
deletion, workflow-schema migration, collaboration, replay execution,
application-level encryption, and production deployment configuration. The standalone
automation library excludes browser lifecycle, queues, service endpoints, persistence,
retries, recording, and interactive replay controls. The Browserbase worker owns only a
single run. Its HTTP service adds private transport, streaming, authentication, health,
and per-process capacity, but still excludes queues, schedules, run persistence,
idempotency, result lookup, reconnection, legacy workflow migration, user authorization,
and authenticated contexts. Workflow documents may contain sensitive values, so request
bodies and workflow contents must not be logged.
