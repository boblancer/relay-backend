# Relay Backend architecture and repository navigation

This document is the detailed onboarding map for engineers and coding agents working
on Relay Backend. It explains where behavior lives, how requests and data move through
the service, and which invariants must survive a change. For installation and routine
commands, see [`README.md`](README.md).

## Purpose and system boundary

Relay Backend is a local proof-of-concept cloud persistence service for Browser Memory
Recorder's canonical workflow documents. A caller such as the recorder's local BFF
sends complete workflow snapshots over HTTP. The backend authenticates the request,
validates it against the canonical model, and stores the workflow in PostgreSQL.

The persistence boundary is the OpenAPI 3.1 contract in [`openapi.yaml`](openapi.yaml).
It defines five authenticated operations:

| Operation | Route | Purpose |
| --- | --- | --- |
| `listWorkflows` | `GET /v1/workflows` | Return privacy-safe workflow summaries. |
| `createWorkflow` | `POST /v1/workflows` | Create an empty server-owned draft. |
| `getWorkflow` | `GET /v1/workflows/{workflowId}` | Return one complete canonical workflow. |
| `saveWorkflow` | `PUT /v1/workflows/{workflowId}` | Atomically save a new workflow revision. |
| `finishWorkflow` | `POST /v1/workflows/{workflowId}/finish` | Save and mark a workflow complete. |

The independent execution boundary is
[`packages/automation-service-browserbase/openapi.yaml`](packages/automation-service-browserbase/openapi.yaml).
It defines private `POST /v1/run` plus unauthenticated liveness and readiness checks.

The service does not record browser activity or execute workflows. It only persists and
retrieves the canonical documents produced elsewhere. The repository also contains the
separate [`@relay/automation-core`](packages/automation-core/README.md) TypeScript
library for background execution. That library neither calls the service nor owns
persistence or browser lifecycle. The separate
[`@relay/automation-worker-browserbase`](packages/automation-worker-browserbase/README.md)
package is its Browserbase-specific server consumer.
The separate
[`@relay/automation-service-browserbase`](packages/automation-service-browserbase/README.md)
package exposes that worker to authenticated internal callers without adding execution
to FastAPI or PostgreSQL.

## Sources of truth and reading order

Use this precedence when documentation and implementation appear to disagree:

1. [`openapi.yaml`](openapi.yaml) is authoritative for the persistence wire contract,
   while [`packages/automation-service-browserbase/openapi.yaml`](packages/automation-service-browserbase/openapi.yaml)
   is authoritative for the stateless execution wire contract.
2. Runtime code under [`src/relay_backend/`](src/relay_backend/) is authoritative for
   current implementation behavior.
3. Tests under [`tests/`](tests/) are executable examples of required behavior.
4. Accepted records under [`docs/decisions/`](docs/decisions/) explain why costly
   architectural choices were made.
5. [`README.md`](README.md), this guide, and [`AGENTS.md`](AGENTS.md) explain and
   navigate those sources; update them when the underlying architecture changes.

For a first pass through the code, read:

1. [`README.md`](README.md) for setup, commands, configuration, and POC boundaries.
2. The applicable `openapi.yaml` for the persistence or execution contract.
3. [`src/relay_backend/main.py`](src/relay_backend/main.py) for application assembly.
4. [`src/relay_backend/controllers/workflows.py`](src/relay_backend/controllers/workflows.py)
   for HTTP-to-service translation.
5. [`src/relay_backend/services/workflows.py`](src/relay_backend/services/workflows.py)
   for business rules and transaction orchestration.
6. [`src/relay_backend/data/workflow_repository.py`](src/relay_backend/data/workflow_repository.py)
   for SQL, locks, and persistence shapes.
7. [`src/relay_backend/models/workflows.py`](src/relay_backend/models/workflows.py) for
   canonical models, summaries, and request hashing.
8. [`tests/`](tests/) for contract, failure, concurrency, and privacy examples.
9. [`packages/automation-core/README.md`](packages/automation-core/README.md) for the
   independent background-automation boundary and public TypeScript API.
10. [`packages/automation-worker-browserbase/README.md`](packages/automation-worker-browserbase/README.md)
    for Browserbase run configuration, CLI usage, and provider lifecycle.
11. [`packages/automation-service-browserbase/README.md`](packages/automation-service-browserbase/README.md)
    for the stateless HTTP contract, configuration, streaming, and operations.

## Architecture overview

The application uses explicit layers and direct dependency flow:

```text
Browser Memory Recorder / local BFF
                  |
                  | HTTP + shared Basic auth
                  v
         RequestBodyLimitMiddleware
                  |
                  v
          FastAPI auth dependency
                  |
                  v
        Workflow HTTP controller
                  |
                  v
           Workflow service
       lifecycle | revisions | idempotency
                  |
                  v
      Database transaction context
                  |
                  v
         Workflow repository
           parameterized SQL
                  |
                  v
             PostgreSQL
```

Dependencies point inward from transport to business behavior to persistence. Pydantic
models are shared by the controller, service, and repository as the canonical in-process
representation. Controllers do not contain lifecycle rules, and the repository does not
interpret HTTP requests.

Background execution is a sibling Node service rather than another FastAPI layer:

```text
POST /v1/run (private bearer authentication)
                             |
                             v
@relay/automation-service-browserbase
     validation | NDJSON | capacity | cancellation
                             |
                             v
@relay/automation-worker-browserbase
       Browserbase lifecycle + parameter resolution
                             |
                             | existing Playwright Page + workflow document
                             v
                  @relay/automation-core
              preflight -> sequential runner
                             |
                             v
             structured events and terminal result
```

The service accepts complete canonical schema 1.2 documents and explicit parameters,
then the worker owns one fresh Browserbase session. Neither shares the Python service's
transaction, repository, authentication, or persistence infrastructure. The service
adds only private HTTP transport; it does not add queues, schedules, or durable runs.

### Application assembly and cross-cutting behavior

[`src/relay_backend/main.py`](src/relay_backend/main.py) builds the FastAPI application:

- The lifespan handler loads environment-backed settings and opens a Psycopg connection
  pool. Tests can inject a service and avoid creating the production pool.
- `RequestBodyLimitMiddleware` runs before routing and enforces the 1 MiB body limit
  from the contract, including streamed bodies without a usable `Content-Length`.
- The workflow router applies shared HTTP Basic authentication to every workflow route.
- Exception handlers translate validation, domain, persistence, and unexpected failures
  into safe contract responses. Unexpected errors log only exception type, HTTP method,
  and path—not workflow content.
- The app serves the checked-in OpenAPI contract rather than FastAPI's generated schema.
  [`src/relay_backend/contract.py`](src/relay_backend/contract.py) loads the repository
  copy during development and the packaged copy from the wheel after installation.

### Layer responsibilities

| Layer | Owns | Must not own |
| --- | --- | --- |
| Controller | Route declarations, headers, path/body binding, response models, and empty-body enforcement. | Transactions, SQL, revision logic, or lifecycle policy. |
| Service | Workflow lifecycle, server-owned fields, revision checks, canonical request hashes, idempotency orchestration, and safe persistence-error mapping. | HTTP response formatting or raw SQL. |
| Database | Connection-pool lifecycle and transaction context. | Domain decisions or query contents. |
| Repository | Parameterized SQL, row locking, canonical document/summary writes, and idempotency-record reads and writes. | HTTP semantics or workflow lifecycle decisions. |
| Models | Strict canonical schemas, discriminated step/parameter variants, validators, summaries, and stable request hashing. | I/O and transaction management. |

## Runtime flows

### Startup and shutdown

1. Uvicorn imports `relay_backend.main:app`.
2. FastAPI enters the lifespan context and builds `Settings` from environment variables
   or `.env`.
3. `Database.open()` starts a Psycopg connection pool and a `WorkflowService` is stored
   on `app.state`.
4. Controllers obtain that service from each incoming request.
5. On shutdown, the lifespan handler closes the pool.

### Read requests

- `GET /v1/workflows/{workflowId}` opens a transaction and selects the canonical
  `document` JSONB value for one workflow.
- `GET /v1/workflows` selects only the precomputed `summary` JSONB values, ordered by
  relational `updated_at DESC`. The query never loads full workflow documents, which
  makes the list endpoint privacy-safe by construction.

### Create, save, and finish mutations

Every mutation executes inside one PostgreSQL transaction:

1. The service builds a SHA-256 request identity from method, path, and canonical JSON.
2. The repository attempts to insert the globally unique idempotency key.
3. An exact completed replay returns the recorded response immediately. A reuse with a
   different method, path, or request hash raises `idempotency_conflict`.
4. Create inserts a server-generated draft. Save and finish lock the existing workflow
   row with `SELECT ... FOR UPDATE` and compare `expectedRevision` to the stored
   revision.
5. The service replaces client-supplied server-owned fields, increments the revision
   once, validates the resulting canonical model, and derives a safe summary.
6. The repository writes the canonical document and summary together, then records the
   successful response against the idempotency key.
7. The transaction commits all changes together. Any failure rolls back both the
   workflow change and the claimed key, so failed mutations do not consume keys.

The row lock serializes competing writes. The conditional `UPDATE ... WHERE revision =
expected_revision` adds a compare-and-swap guard; exactly one concurrent writer can
advance a given revision.

### Validation and error flow

FastAPI and Pydantic reject malformed path, header, and body data. The service
revalidates save requests at its boundary so direct service callers receive the same
strict guarantees as HTTP callers. Domain exceptions are deliberately safe to expose;
Psycopg connectivity failures become `503 unavailable`, while other persistence and
unexpected failures become generic `500 internal` responses.

## Data architecture

PostgreSQL schema changes are ordered Alembic migrations. Runtime access uses direct
Psycopg rather than SQLAlchemy; SQLAlchemy is present only because Alembic uses it for
migrations.

### `workflows`

| Column group | Purpose |
| --- | --- |
| `id`, `revision`, `status` | Identity, optimistic concurrency, and lifecycle fields used by SQL. |
| `created_at`, `updated_at`, `finished_at` | Server-owned lifecycle timestamps and list ordering. |
| `document` JSONB | Complete canonical workflow returned by the detail endpoint. |
| `summary` JSONB | Precomputed safe projection returned by list operations. |

The relational columns duplicate selected document fields intentionally so the database
can lock, compare, constrain, and order records without querying arbitrary JSON. The
document and summary must always be written in the same transaction.

### `idempotency_records`

The UUID `key` is the global primary key. Each record stores the request method, path,
canonical request hash, response status, response body, and creation time. Successful
records are retained indefinitely in this POC. A claimed record is completed only after
the workflow operation succeeds, in the same transaction.

## Repository file structure

Generated artifacts, caches, virtual environments, and `dist/` packages are omitted.

```text
relay_backend/
├── AGENTS.md                         Agent entry point and non-negotiable guardrails
├── NAVIGATION.md                     Detailed architecture and ownership guide
├── README.md                         Setup, commands, configuration, and POC scope
├── openapi.yaml                      Authoritative external API contract
├── pyproject.toml                    Package metadata, dependencies, pytest, and Ruff
├── uv.lock                           Resolved Python dependency lockfile
├── compose.yaml                      Local PostgreSQL 17 service and persistent volume
├── .env.example                      Non-secret configuration template
├── .gitignore                        Local and generated-file exclusions
├── alembic.ini                       Alembic paths, database default, and logging
├── docs/
│   └── decisions/
│       ├── 0001-postgresql-jsonb-persistence.md
│       ├── 0002-shared-basic-authentication.md
│       ├── 0003-standalone-typescript-automation-core.md
│       ├── 0004-browserbase-background-worker.md
│       └── 0005-stateless-browserbase-run-service.md
├── packages/
│   ├── automation-core/
│   │   ├── package.json               Private ESM package metadata and scripts
│   │   ├── package-lock.json          Package-local locked dependency graph
│   │   ├── README.md                  Public API, usage, and deliberate boundaries
│   │   ├── src/                       Contract, preflight, execution, and runner
│   │   └── tests/                     Contract, behavior, cancellation, privacy tests
│   ├── automation-worker-browserbase/
│       ├── package.json               Private worker library and CLI metadata
│       ├── package-lock.json          Worker dependency lockfile
│       ├── README.md                  CLI, configuration, privacy, and run boundaries
│       ├── src/                       Preparation, Browserbase lifecycle, and JSONL CLI
│       └── tests/                     Parameters, lifecycle, CLI, privacy, and opt-in smoke tests
│   └── automation-service-browserbase/
│       ├── package.json               Private Fastify service metadata and scripts
│       ├── package-lock.json          Service dependency lockfile
│       ├── openapi.yaml               Authoritative stateless run-service contract
│       ├── README.md                  HTTP, configuration, privacy, and operations
│       ├── src/                       Configuration, HTTP lifecycle, and process entry point
│       └── tests/                     Contract, streaming, lifecycle, integration, and smoke tests
├── migrations/
│   ├── env.py                        Alembic online/offline runtime configuration
│   ├── script.py.mako                Migration revision template
│   └── versions/
│       └── 0001_initial.py            Workflow and idempotency table definitions
├── src/
│   └── relay_backend/
│       ├── __init__.py                Package marker
│       ├── main.py                    App factory, lifespan, middleware, error mapping
│       ├── settings.py                Required environment-backed configuration
│       ├── auth.py                    Shared Basic authentication dependency
│       ├── request_limits.py          ASGI request-body size enforcement
│       ├── contract.py                Repository/installed OpenAPI contract loader
│       ├── errors.py                  Safe domain and persistence exceptions
│       ├── controllers/
│       │   └── workflows.py           Workflow HTTP routes
│       ├── services/
│       │   └── workflows.py           Business rules and transaction orchestration
│       ├── data/
│       │   ├── database.py            Psycopg connection pool and transactions
│       │   └── workflow_repository.py Parameterized SQL and row locking
│       └── models/
│           └── workflows.py           Canonical Pydantic workflow model family
└── tests/
    ├── conftest.py                    Migration and database-cleanup fixtures
    ├── test_api.py                    HTTP, auth, errors, limits, and served contract
    ├── test_service.py                Transactions, concurrency, privacy, idempotency
    └── test_models.py                 Validation, variants, summaries, schema agreement
```

Empty `__init__.py` files under the controller, service, data, model, and test packages
are package markers and contain no runtime behavior.

## Detailed ownership map

| Path | Responsibility |
| --- | --- |
| [`src/relay_backend/main.py`](src/relay_backend/main.py) | Builds the app, owns dependency lifetime, installs middleware/routes, serves the contract, and maps failures to safe API errors. |
| [`src/relay_backend/settings.py`](src/relay_backend/settings.py) | Declares required database and shared-auth environment settings. |
| [`src/relay_backend/auth.py`](src/relay_backend/auth.py) | Validates shared credentials with constant-time byte comparisons. |
| [`src/relay_backend/request_limits.py`](src/relay_backend/request_limits.py) | Enforces the 1 MiB request-body limit for declared and streamed body sizes. |
| [`src/relay_backend/contract.py`](src/relay_backend/contract.py) | Selects and parses the repository or packaged OpenAPI document. |
| [`src/relay_backend/errors.py`](src/relay_backend/errors.py) | Defines failures whose messages are safe at the HTTP boundary. |
| [`src/relay_backend/controllers/workflows.py`](src/relay_backend/controllers/workflows.py) | Maps the five workflow operations to service calls. |
| [`src/relay_backend/services/workflows.py`](src/relay_backend/services/workflows.py) | Implements create/save/finish lifecycle behavior, revisions, hashes, and transaction error mapping. |
| [`src/relay_backend/data/database.py`](src/relay_backend/data/database.py) | Owns the Psycopg pool and transaction context manager. |
| [`src/relay_backend/data/workflow_repository.py`](src/relay_backend/data/workflow_repository.py) | Executes workflow, summary, lock, and idempotency SQL. |
| [`src/relay_backend/models/workflows.py`](src/relay_backend/models/workflows.py) | Defines strict camelCase API models, workflow-step variants, safe summaries, and canonical hashing. |
| [`migrations/`](migrations/) | Configures Alembic and stores ordered, reversible database changes. |
| [`tests/test_models.py`](tests/test_models.py) | Proves strict model behavior and OpenAPI schema compatibility. |
| [`tests/test_service.py`](tests/test_service.py) | Proves lifecycle, transaction, concurrency, privacy, ordering, and idempotency behavior against PostgreSQL. |
| [`tests/test_api.py`](tests/test_api.py) | Proves authentication, routes, errors, limits, and served-contract behavior. |
| [`tests/conftest.py`](tests/conftest.py) | Applies migrations once and truncates only the two application tables between tests. |
| [`docs/decisions/`](docs/decisions/) | Preserves the rationale and consequences of accepted architecture/security decisions. |
| [`packages/automation-core/src/workflow.ts`](packages/automation-core/src/workflow.ts) | Defines the strict TypeScript schema 1.2 contract and locator ordering used by automation. |
| [`packages/automation-core/src/preflight.ts`](packages/automation-core/src/preflight.ts) | Validates runner inputs, start selection, enabled ranges, and bootstrap URL choice. |
| [`packages/automation-core/src/execution.ts`](packages/automation-core/src/execution.ts) | Owns Playwright actions, frame/locator resolution, settling, waits, and cancellation boundaries. |
| [`packages/automation-core/src/runner.ts`](packages/automation-core/src/runner.ts) | Runs steps sequentially and returns transport-neutral events and terminal results. |
| [`packages/automation-core/tests/`](packages/automation-core/tests/) | Proves contract agreement, behavior parity, fail-fast execution, cancellation, and diagnostic privacy. |
| [`packages/automation-worker-browserbase/src/`](packages/automation-worker-browserbase/src/) | Validates complete run inputs, resolves parameters, owns Browserbase lifecycle, and exposes the JSONL CLI. |
| [`packages/automation-worker-browserbase/tests/`](packages/automation-worker-browserbase/tests/) | Proves worker lifecycle, cleanup, timeout, parameter, CLI, and privacy behavior without paid sessions by default. |
| [`packages/automation-service-browserbase/openapi.yaml`](packages/automation-service-browserbase/openapi.yaml) | Defines the independent `POST /v1/run` and health wire contract. |
| [`packages/automation-service-browserbase/src/`](packages/automation-service-browserbase/src/) | Owns bearer authentication, request limits, NDJSON transport, local capacity, disconnect cancellation, and shutdown. |
| [`packages/automation-service-browserbase/tests/`](packages/automation-service-browserbase/tests/) | Proves the service contract and worker integration without paid sessions by default. |

## Where to make common changes

| Change | Start here | Also inspect or update |
| --- | --- | --- |
| Add or change an API route | [`openapi.yaml`](openapi.yaml) | Controller, service, API tests, and packaged-contract behavior. |
| Change workflow or step fields | [`openapi.yaml`](openapi.yaml) and [`models/workflows.py`](src/relay_backend/models/workflows.py) | Model tests, request hashing, summaries, and schema-version policy. |
| Change lifecycle or revision behavior | [`services/workflows.py`](src/relay_backend/services/workflows.py) | OpenAPI mutation semantics and service concurrency tests. |
| Change idempotency semantics | [`services/workflows.py`](src/relay_backend/services/workflows.py) and [`workflow_repository.py`](src/relay_backend/data/workflow_repository.py) | Schema, contract text, replay/conflict tests, and possibly a new ADR. |
| Change stored data or indexes | [`migrations/versions/`](migrations/versions/) | Repository SQL, downgrade behavior, tests, and ADR 0001. |
| Change list output | `WorkflowSummary` and `to_workflow_summary` in [`models/workflows.py`](src/relay_backend/models/workflows.py) | Repository list query, OpenAPI schemas, and privacy assertions. |
| Change authentication | [`auth.py`](src/relay_backend/auth.py) | Settings, OpenAPI security, API tests, and ADR 0002. |
| Change error behavior | [`errors.py`](src/relay_backend/errors.py) and [`main.py`](src/relay_backend/main.py) | OpenAPI responses and safe-error tests. |
| Change request-size limits | [`request_limits.py`](src/relay_backend/request_limits.py) | `x-contract-semantics`, request-body docs, and boundary tests. |
| Add configuration | [`settings.py`](src/relay_backend/settings.py) | [`.env.example`](.env.example), README configuration table, and tests. |
| Change packaging or dependencies | [`pyproject.toml`](pyproject.toml) | `uv.lock`, contract packaging, and README requirements. |
| Change background automation behavior | [`packages/automation-core/src/runner.ts`](packages/automation-core/src/runner.ts) and [`execution.ts`](packages/automation-core/src/execution.ts) | Package tests, public exports, package README, and ADR 0003 boundaries. |
| Change Browserbase run lifecycle | [`packages/automation-worker-browserbase/src/worker.ts`](packages/automation-worker-browserbase/src/worker.ts) | Worker tests, CLI output, package README, and ADR 0004 boundaries. |
| Change the stateless execution API | [`packages/automation-service-browserbase/openapi.yaml`](packages/automation-service-browserbase/openapi.yaml) | Service runtime, tests, README, and ADR 0005 boundaries. |

## Invariants to preserve

- Root `openapi.yaml` remains the authoritative persistence contract served by FastAPI
  at `/openapi.json`; the package-local service contract remains independent.
- All workflow endpoints require the configured shared Basic credentials; credential
  checks remain constant-time and failures remain indistinguishable.
- The server owns workflow IDs, schema version, lifecycle fields, timestamps, and
  revision increments.
- A successful new mutation increments the revision exactly once.
- Revision comparison and writes remain atomic under concurrent requests.
- Idempotency keys are global. Exact replays return the original result; changed
  requests return `409 idempotency_conflict`.
- Failed mutations do not consume an idempotency key.
- Canonical documents and safe summaries are updated together in one transaction.
- List queries never load or expose workflow payloads, targets, parameter values, or
  source session IDs.
- Errors and logs never include workflow bodies, credentials, or persistence details.
- Runtime SQL remains parameterized.
- Request bodies larger than 1 MiB are rejected whether or not `Content-Length` is
  present or valid.
- The automation core accepts an existing Playwright `Page`; it does not create or
  persist browser sessions, call Browserbase, or depend on FastAPI/PostgreSQL.
- Automation events, terminal results, and thrown execution diagnostics exclude action
  payloads, target and locator values, URLs, workflow bodies, and source session IDs.
- The Browserbase worker accepts only complete schema 1.2 workflows, never reuses the
  recorded source session, never retries actions, and always attempts session cleanup.
- Worker JSONL excludes workflow bodies, URLs, payloads, parameter values, connection
  details, provider session IDs, and raw errors.
- The run service accepts only full request-scoped workflows; it never reads or writes
  PostgreSQL and never calls the persistence API.
- Run-service authorization uses a dedicated bearer token, and request/header logging
  remains disabled. All stream lines contain only a generated run ID plus safe worker or
  service fields.
- A valid stream contains exactly one terminal outcome. Disconnect and shutdown abort
  the worker; capacity exhaustion returns `429` without an in-memory queue.

## Configuration, packaging, and local dependencies

- [`Settings`](src/relay_backend/settings.py) requires `DATABASE_URL`,
  `BASIC_AUTH_USERNAME`, and `BASIC_AUTH_PASSWORD`. Tests optionally use
  `TEST_DATABASE_URL` directly from their fixture configuration.
- The Browserbase worker reads `BROWSERBASE_API_KEY` for real runs and optionally
  `BROWSERBASE_PROJECT_ID`, `BROWSERBASE_REGION`, `BROWSERBASE_USE_PROXY`, and
  `BROWSERBASE_VERIFIED`. Validation-only CLI use does not require credentials.
- The run service additionally requires `AUTOMATION_SERVICE_TOKEN`, reads listen,
  capacity, deadline, and shutdown settings from the process environment, and does not
  load another repository's environment files.
- [`.env.example`](.env.example) contains local placeholders only. Real `.env` files are
  ignored and must never be committed or copied into documentation.
- [`compose.yaml`](compose.yaml) binds PostgreSQL only to localhost and persists data in
  the `relay-postgres` named volume.
- [`pyproject.toml`](pyproject.toml) requires Python 3.12 or newer, uses Hatchling with a
  `src/` package layout, and force-includes `openapi.yaml` in built wheels.
- [`uv.lock`](uv.lock) pins the resolved dependency graph and should change together
  with dependency declarations.
- [`packages/automation-core/package-lock.json`](packages/automation-core/package-lock.json)
  independently locks the TypeScript library's development and runtime dependencies.
- [`packages/automation-worker-browserbase/package-lock.json`](packages/automation-worker-browserbase/package-lock.json)
  independently locks the Browserbase worker and its local automation-core dependency.
- [`packages/automation-service-browserbase/package-lock.json`](packages/automation-service-browserbase/package-lock.json)
  independently locks Fastify and its local Browserbase worker dependency.

## Testing architecture

The test session applies all Alembic migrations to `TEST_DATABASE_URL`, or to the local
Compose database when that variable is absent. Before each test, fixtures truncate only
`workflows` and `idempotency_records`.

- Model tests are mostly pure and verify strict validation, every discriminated step and
  parameter variant, safe sorted summaries, stable request hashes, and agreement with
  the authoritative OpenAPI schema.
- Service tests use PostgreSQL to verify atomic revisions, exact replays, global key
  conflicts, rollback behavior, concurrent writers, ordering, and privacy-safe reads.
- API tests exercise the assembled FastAPI app, shared authentication, contract error
  shapes, request limits, safe failures, and the exact served OpenAPI document.
- Automation package tests are pure TypeScript tests. They exercise schema/preflight,
  all nine Playwright actions, locator/frame behavior, settling and waits,
  cancellation, sequential fail-fast execution, and privacy-safe diagnostics.
- Browserbase worker tests use provider and browser fakes. A navigation-only paid smoke
  test runs only when `BROWSERBASE_E2E=1` is set explicitly.
- Run-service tests exercise HTTP streaming, authentication, capacity, disconnect,
  shutdown, and the real worker with provider fakes. Its HTTP Browserbase smoke test is
  gated by the same explicit `BROWSERBASE_E2E=1` opt-in.

## POC boundaries

The persistence service intentionally excludes user accounts, tenants, ownership rules,
pagination, deletion, workflow-schema migration, collaboration, replay execution,
local-file mirroring, application-level encryption, production deployment configuration,
and idempotency-record expiry. The automation library intentionally excludes browser
and Browserbase lifecycle, jobs, schedules, service APIs, authentication, execution
persistence, retries, recording, and interactive replay controls. HTTP Basic must be
placed behind TLS if the service is exposed beyond localhost.
The Browserbase worker excludes queues, schedules, and durable run records. Its sibling
HTTP service remains stateless and excludes scheduling, idempotency, lookup,
reconnection, user authorization, legacy workflow migration, authenticated contexts,
and automatic retries.

Do not silently design these capabilities into unrelated changes. A costly-to-reverse
addition or replacement should be recorded as a new ADR under
[`docs/decisions/`](docs/decisions/).

## Local verification

Start PostgreSQL and load the environment as described in [`README.md`](README.md), then
run:

```bash
npm ci --prefix packages/automation-core
npm run typecheck --prefix packages/automation-core
npm test --prefix packages/automation-core
npm run build --prefix packages/automation-core
npm pack --dry-run ./packages/automation-core

npm ci --prefix packages/automation-worker-browserbase
npm run typecheck --prefix packages/automation-worker-browserbase
npm test --prefix packages/automation-worker-browserbase
npm run build --prefix packages/automation-worker-browserbase
npm pack --dry-run ./packages/automation-worker-browserbase

npm ci --prefix packages/automation-service-browserbase
npm run typecheck --prefix packages/automation-service-browserbase
npm test --prefix packages/automation-service-browserbase
npm run build --prefix packages/automation-service-browserbase
npm pack --dry-run ./packages/automation-service-browserbase

uv lock --check
uv run ruff check src tests migrations
uv run ruff format --check src tests
uv run pytest
uv run python -m openapi_spec_validator openapi.yaml
uv run python -m openapi_spec_validator packages/automation-service-browserbase/openapi.yaml
```

Before submitting an architecture-affecting change, also verify that this guide,
[`AGENTS.md`](AGENTS.md), [`README.md`](README.md), the contract, and relevant ADRs still
agree with the code.

## Architecture decisions

- [`ADR 0001: PostgreSQL with canonical JSONB workflow documents`](docs/decisions/0001-postgresql-jsonb-persistence.md)
- [`ADR 0002: Shared HTTP Basic authentication`](docs/decisions/0002-shared-basic-authentication.md)
- [`ADR 0003: Standalone TypeScript automation core`](docs/decisions/0003-standalone-typescript-automation-core.md)
- [`ADR 0004: Browserbase background worker`](docs/decisions/0004-browserbase-background-worker.md)
- [`ADR 0005: Stateless Browserbase run service`](docs/decisions/0005-stateless-browserbase-run-service.md)

When a decision changes, add a new sequential record that supersedes the older one.
Preserve accepted historical records rather than rewriting or deleting their rationale.
