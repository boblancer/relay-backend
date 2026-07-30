# Relay Backend

Local proof-of-concept persistence backend for Browser Memory Recorder's canonical
workflow documents. The service implements the repository's `openapi.yaml`, including
atomic revisions, global idempotency, privacy-safe summaries, and shared HTTP Basic
authentication.

## Quick start

Requirements:

- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/)
- Docker with Compose

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

Successful idempotency records are retained indefinitely. A replay with the same key,
method, path, and validated canonical JSON returns the original response even if the
workflow has since changed. Different content returns `409 idempotency_conflict`.

See [ADR 0001](docs/decisions/0001-postgresql-jsonb-persistence.md) and
[ADR 0002](docs/decisions/0002-shared-basic-authentication.md) for the POC tradeoffs.

## POC boundaries

This version intentionally excludes user accounts, tenants, pagination, deletion,
workflow-schema migration, collaboration, replay execution, application-level
encryption, and production deployment configuration. Workflow documents may contain
sensitive values, so request bodies and workflow contents must not be logged.

