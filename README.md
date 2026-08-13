# Relay Backend

Local proof-of-concept persistence backend for Browser Memory Recorder's canonical
workflow documents, plus provider-neutral automation, a Browserbase worker, and a
private internal execution service with streaming and in-memory batch APIs.
The FastAPI service implements the repository's `openapi.yaml`, including atomic
revisions, global idempotency, privacy-safe summaries, and shared HTTP Basic
authentication. It also exposes an authenticated UUID-based gateway to the private run
service. Organizational namespaces own workflows without acting as authorization
boundaries. Canonical workflow documents live in a private Railway Storage Bucket;
PostgreSQL stores their active object keys and safe relational metadata. The service does
not execute workflows itself.

## Quick start

Requirements:

- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/)
- Docker with Compose
- A private Railway Storage Bucket and its S3-compatible credentials
- Node.js 24 or newer for automation packages

```bash
cp .env.example .env
uv sync --extra dev
docker compose up -d --wait postgres
set -a
source .env
set +a
uv run alembic upgrade head
uv run uvicorn relay_backend.main:app --reload --no-access-log
```

The API is available at `http://127.0.0.1:8000`. The read-only Scalar API reference is
at `http://127.0.0.1:8000/docs`; its selector includes **Workflow Storage** and
**Workflow Runs**. The persistence contract remains available from
`http://127.0.0.1:8000/openapi.json`. The local documentation page loads its pinned
Scalar browser bundle from jsDelivr, so opening it requires internet access.

The run reference documents the separate private Browserbase service. FastAPI adds
`POST /v1/run-by-id`, which resolves a stored workflow and forwards the existing run
interface without buffering or retrying it. The optional local `/api/inngest` adapter is orchestration
owned by the Inngest SDK, not a third Relay API, so use the local Inngest guide and UI
rather than the API reference for that path.

Create a namespace, then create a draft in it using fresh UUIDs for each logical mutation:

```bash
curl \
  --user "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" \
  --header "Idempotency-Key: $(python -c 'import uuid; print(uuid.uuid4())')" \
  --header "Content-Type: application/json" \
  --data '{"name":"Personal"}' \
  --request POST \
  http://127.0.0.1:8000/v1/namespaces

# Copy the returned namespace id.
NAMESPACE_ID="..."

curl \
  --user "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" \
  --header "Idempotency-Key: $(python -c 'import uuid; print(uuid.uuid4())')" \
  --request POST \
  "http://127.0.0.1:8000/v1/namespaces/$NAMESPACE_ID/workflows"
```

The flat `/v1/workflows` routes remain deprecated compatibility aliases in contract
version 1.2. Flat creation targets `Default`; flat reads and mutations retain global
workflow-ID behavior. Their removal is reserved for contract version 2.0.

With the private automation service running, execute a completed stored workflow by UUID:

```bash
curl \
  --user "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" \
  --header "Accept: application/x-ndjson" \
  --header "Content-Type: application/json" \
  --data "{\"workflowId\":\"$WORKFLOW_ID\"}" \
  --no-buffer \
  http://127.0.0.1:8000/v1/run-by-id
```

The response is the private service's NDJSON stream. Disconnecting closes the upstream
request, runs are never retried automatically, and relative terminal thumbnail URLs are
served through authenticated `GET /v1/artifacts/{artifactId}`.

## Commands

| Command | Purpose |
| --- | --- |
| `docker compose up -d --wait postgres` | Start local PostgreSQL |
| `uv run alembic upgrade head` | Apply database migrations |
| `uv run python -m relay_backend.backfill_workflow_documents` | Move legacy JSONB documents to the configured bucket |
| `uv run uvicorn relay_backend.main:app --reload --no-access-log` | Start the API without logging sensitive artifact URLs |
| `uv run pytest` | Run unit, contract, API, and PostgreSQL integration tests |
| `uv run ruff check src tests migrations` | Lint Python code |
| `uv run ruff format --check src tests` | Verify formatting |
| `npm ci --prefix packages/automation-core` | Install the automation library's locked dependencies |
| `npm test --prefix packages/automation-core` | Run automation contract and execution tests |
| `npm run build --prefix packages/automation-core` | Build the TypeScript library and declarations |
| `npm ci --prefix packages/automation-worker-browserbase` | Install the Browserbase worker's locked dependencies after building automation-core |
| `npm test --prefix packages/automation-worker-browserbase` | Run Browserbase worker tests without creating paid sessions |
| `npm run build --prefix packages/automation-worker-browserbase` | Build the Browserbase worker library and CLI |
| `npm ci --prefix packages/automation-service-browserbase` | Install the execution service's locked dependencies after building the worker |
| `npm test --prefix packages/automation-service-browserbase` | Run HTTP, lifecycle, integration, and privacy tests without paid sessions |
| `npm run build --prefix packages/automation-service-browserbase` | Build the Fastify service and declarations |
| `npm start --prefix packages/automation-service-browserbase` | Start the execution service |

Tests use `TEST_DATABASE_URL` when set and otherwise use the local Compose database.
They truncate workflow and idempotency data and remove non-default test namespaces
between cases.

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
| `BUCKET` | Railway bucket's globally unique S3 API name |
| `ENDPOINT` | Railway S3 endpoint, normally `https://storage.railway.app` |
| `ACCESS_KEY_ID` | Private Railway bucket access-key ID |
| `SECRET_ACCESS_KEY` | Private Railway bucket secret access key |
| `REGION` | Railway bucket region, normally `auto` |
| `AUTOMATION_SERVICE_URL` | Private Browserbase run-service base URL; defaults to `http://127.0.0.1:8080` |
| `TEST_DATABASE_URL` | Optional PostgreSQL URL used by tests |
| `BROWSERBASE_API_KEY` | Browserbase worker credential; required only for real runs |
| `BROWSERBASE_PROJECT_ID` | Optional Browserbase project selection |
| `BROWSERBASE_REGION` | Browserbase session region; defaults to `us-west-2` |
| `BROWSERBASE_USE_PROXY` | Opt into managed proxy routing; defaults to `false` |
| `BROWSERBASE_VERIFIED` | Request Verified mode; defaults to `false` |
| `AUTOMATION_HOST` / `PORT` | Run-service listen address; defaults to `127.0.0.1:8080` |
| `AUTOMATION_MAX_CONCURRENT_RUNS` | Shared per-process run capacity; defaults to `5` |
| `AUTOMATION_RETRY_AFTER_SECONDS` | Capacity response delay hint; defaults to `1` |
| `AUTOMATION_RUN_TIMEOUT_MS` | Run deadline, at most 10 minutes; defaults to `600000` |
| `AUTOMATION_STEP_TIMEOUT_MS` | Step deadline, at most 60 seconds; defaults to `60000` |
| `AUTOMATION_SHUTDOWN_GRACE_MS` | Cancellation cleanup grace; defaults to `30000` |
| `AUTOMATION_SCREENSHOTS` | Terminal screenshot capture; defaults to `true` and requires loopback |
| `AUTOMATION_ARTIFACT_DIR` | Persistent screenshot directory; defaults to repository `.relay/artifacts` |
| `INNGEST_DEV` | Set exactly `1` with a loopback `AUTOMATION_HOST` to enable the local-only Inngest POC endpoint |

No credentials are built into the application. Copy `.env.example` to the ignored
`.env` file, replace the example password, and populate the service-specific secrets
you use. Optional overrides are omitted from the sample; their runtime defaults are
listed above.

### Railway document-store rollout

Create a private Storage Bucket in each Railway environment and auto-inject its `BUCKET`,
`ENDPOINT`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, and `REGION` variables into the API
service. Deploy the migration and dual-read application before running:

```bash
uv run python -m relay_backend.backfill_workflow_documents --batch-size 100
```

The command is resumable and never changes revisions, timestamps, summaries, or
idempotency records. Verify the cutover with
`SELECT count(*) FROM workflows WHERE document_key IS NULL`; the result must be zero.
Keep the legacy JSONB column until a later migration after production verification.

## Architecture

The code uses explicit layers without framework-heavy abstractions:

```text
                         ┌→ Data repository → PostgreSQL metadata and summaries
Controller → Service ───┤
                         └→ Document store → private Railway Storage Bucket
```

- Controllers translate HTTP requests and responses only.
- The service owns lifecycle, revision, canonicalization, and idempotency behavior.
- The data layer owns parameterized metadata, pointer, summary, and idempotency SQL.
- The document store owns deterministic, bounded canonical workflow objects. PostgreSQL
  publishes the active opaque object key in the same transaction as the safe summary.
- List queries select only PostgreSQL summaries and cannot accidentally return payloads
  or session IDs.
- Alembic uses SQLAlchemy for migrations; runtime queries use Psycopg directly.
- The run gateway resolves a stored workflow by UUID, then streams requests and responses
  between the authenticated FastAPI boundary and the private execution service.

[`packages/automation-core`](packages/automation-core/README.md) is an independent ESM
library. A background runner supplies an existing Playwright `Page`, receives
transport-neutral events and structured results, and remains responsible for browser
lifecycle and any persistence. The package has no dependency on FastAPI, PostgreSQL,
Browserbase, or the service's internal persistence model.

[`packages/automation-worker-browserbase`](packages/automation-worker-browserbase/README.md)
is the provider-specific server consumer. It validates complete workflows while treating
the required `schemaVersion` value as opaque metadata,
resolves explicit run parameters, owns fresh Browserbase session lifecycle, and returns
privacy-safe events and outcomes. It does not add an execution route to FastAPI or
persist run state. Visibility and text-containment assertions execute once without retries.

[`packages/automation-service-browserbase`](packages/automation-service-browserbase/README.md)
is a separate Fastify process exposing unauthenticated local direct and batch execution APIs.
`POST /v1/run` streams privacy-safe NDJSON and cancels on disconnect. `POST /v1/batches`
queues one to ten workflows in process memory, while `GET /v1/batches/{batchId}` polls
safe progress for up to one hour. Batch, direct, and opt-in local Inngest work share the
same five-slot default capacity. The process does not call the persistence API or use
PostgreSQL, and all batch state disappears on restart. Direct and batch terminal
outcomes may include a one-hour loopback thumbnail URL backed by a compressed file in
`.relay/artifacts`; files persist for manual cleanup, but URL access does not survive a
restart. The Inngest path does not capture screenshots.
The Node service still does not read persistence; only FastAPI performs UUID resolution.

Successful idempotency records are retained indefinitely. A replay with the same key,
method, path, and validated canonical JSON returns the original response even if the
workflow has since changed. Different content returns `409 idempotency_conflict`.

See [ADR 0010](docs/decisions/0010-railway-workflow-document-storage.md) for the
superseding canonical-document persistence decision. See
[ADR 0001](docs/decisions/0001-postgresql-jsonb-persistence.md) for the original JSONB
decision and
[ADR 0002](docs/decisions/0002-shared-basic-authentication.md) for the POC tradeoffs.
See [ADR 0003](docs/decisions/0003-standalone-typescript-automation-core.md) for the
automation-library boundary.
See [ADR 0004](docs/decisions/0004-browserbase-background-worker.md) for the Browserbase
worker's original boundary. See
[ADR 0005](docs/decisions/0005-stateless-browserbase-run-service.md) for the superseding
stateless HTTP service decision. See
[ADR 0006](docs/decisions/0006-schema-1.3-assertion-execution.md) for the original
schema 1.3 assertion semantics and
[ADR 0012](docs/decisions/0012-opaque-execution-schema-version.md) for the superseding
version-agnostic execution admission rule. See
[ADR 0013](docs/decisions/0013-authenticated-workflow-run-gateway.md) for the
authenticated UUID-based FastAPI gateway. See
[ADR 0007](docs/decisions/0007-in-memory-background-batches.md) for process-local batch
queueing and polling. See
[ADR 0008](docs/decisions/0008-unauthenticated-local-execution-service.md) for the
execution service's unauthenticated loopback-only POC boundary.
See [ADR 0009](docs/decisions/0009-local-terminal-screenshot-artifacts.md) for terminal
screenshot capture, persistent local files, and temporary URL access.

## POC boundaries

The FastAPI service intentionally excludes user accounts, tenant authorization,
namespace rename/deletion/transfer, pagination, workflow deletion, workflow-schema
migration, collaboration, replay execution,
and application-level encryption. The standalone
automation library excludes browser lifecycle, queues, service endpoints, persistence,
retries, recording, and interactive replay controls. The Browserbase worker owns only a
single run. Its HTTP service adds local transport, streaming, health,
shared per-process capacity, and a bounded in-memory batch queue. It still excludes
schedules, durable run persistence, idempotency, reconnection, legacy workflow migration,
user authorization, and authenticated contexts. Workflow documents may contain sensitive
values, so request bodies and workflow contents must not be logged.
Terminal screenshot files are a deliberate local exception to the no-persistence run
model; they have no durable API index and are never deleted automatically.
The execution service has no authentication and defaults to loopback; it is not safe to
expose publicly.
