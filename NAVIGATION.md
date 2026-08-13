# Relay Backend architecture and repository navigation

This document is the detailed onboarding map for engineers and coding agents working
on Relay Backend. It explains where behavior lives, how requests and data move through
the service, and which invariants must survive a change. For installation and routine
commands, see [`README.md`](README.md).

## Purpose and system boundary

Relay Backend is a local proof-of-concept cloud persistence service and authenticated
execution gateway for Browser Memory
Recorder's canonical workflow documents. A caller such as the recorder's local BFF
sends complete workflow snapshots over HTTP. The backend authenticates the request,
validates it against the canonical model, stores the canonical document in a private
Railway Storage Bucket, and publishes its metadata and active object key in PostgreSQL.

The authenticated FastAPI boundary is the OpenAPI 3.1 contract in [`openapi.yaml`](openapi.yaml).
It defines three namespace operations and five canonical namespace-scoped workflow
operations:

| Operation | Route | Purpose |
| --- | --- | --- |
| `listNamespaces` | `GET /v1/namespaces` | Return namespace metadata. |
| `createNamespace` | `POST /v1/namespaces` | Create an organizational namespace. |
| `getNamespace` | `GET /v1/namespaces/{namespaceId}` | Return namespace metadata. |
| `listWorkflows` | `GET /v1/namespaces/{namespaceId}/workflows` | Return scoped safe summaries. |
| `createWorkflow` | `POST /v1/namespaces/{namespaceId}/workflows` | Create an owned draft. |
| `getWorkflow` | `GET /v1/namespaces/{namespaceId}/workflows/{workflowId}` | Return an owned workflow. |
| `saveWorkflow` | `PUT /v1/namespaces/{namespaceId}/workflows/{workflowId}` | Save an owned revision. |
| `finishWorkflow` | `POST /v1/namespaces/{namespaceId}/workflows/{workflowId}/finish` | Save and complete an owned workflow. |

The five flat `/v1/workflows` operations remain deprecated global compatibility aliases
for OpenAPI 1.3. Flat creation uses `Default`; removal is reserved for version 2.0.
`POST /v1/run-by-id` resolves one workflow through the global compatibility lookup and
streams the private run service's existing interface. Public `POST /v1/batches` forwards
one to ten opaque full workflow documents and `GET /v1/batches/{batchId}` polls the
process-local result. `GET /v1/artifacts/{artifactId}` preserves temporary relative
thumbnail capabilities behind shared Basic auth.

The independent execution boundary is
[`packages/automation-service-browserbase/openapi.yaml`](packages/automation-service-browserbase/openapi.yaml).
It defines unauthenticated local direct-run and in-memory batch operations plus
liveness and readiness checks.

The service does not record browser activity or execute workflows in-process. It persists
and retrieves canonical documents and gateways selected documents to the private run
service. The repository also contains the
separate [`@relay/automation-core`](packages/automation-core/README.md) TypeScript
library for background execution. That library neither calls the service nor owns
persistence or browser lifecycle. The separate
[`@relay/automation-worker-browserbase`](packages/automation-worker-browserbase/README.md)
package is its Browserbase-specific server consumer.
The separate
[`@relay/automation-service-browserbase`](packages/automation-service-browserbase/README.md)
package exposes that worker to local callers without adding execution logic
to FastAPI or PostgreSQL.

## Sources of truth and reading order

Use this precedence when documentation and implementation appear to disagree:

1. [`openapi.yaml`](openapi.yaml) is authoritative for the persistence wire contract,
   while [`packages/automation-service-browserbase/openapi.yaml`](packages/automation-service-browserbase/openapi.yaml)
   is authoritative for the execution wire contract.
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
8. [`src/relay_backend/document_store.py`](src/relay_backend/document_store.py) for
   bounded deterministic object serialization and S3 transport.
9. [`tests/`](tests/) for contract, failure, concurrency, and privacy examples.
10. [`packages/automation-core/README.md`](packages/automation-core/README.md) for the
   independent background-automation boundary and public TypeScript API.
11. [`packages/automation-worker-browserbase/README.md`](packages/automation-worker-browserbase/README.md)
    for Browserbase run configuration, CLI usage, and provider lifecycle.
12. [`packages/automation-service-browserbase/README.md`](packages/automation-service-browserbase/README.md)
    for the streaming and in-memory batch HTTP contract, configuration, and operations.

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
    Namespace/workflow HTTP controllers
                  |
                  v
       Namespace/workflow services
 ownership | lifecycle | revisions | idempotency
          +-------+-------+
          |               |
          v               v
 Document store      Database transaction
 deterministic JSON        |
          |                 v
          |         Workflow repository
          |          parameterized SQL
          v                 v
 private Railway       PostgreSQL metadata,
 Storage Bucket        summaries, pointers
```

For UUID-based direct execution, the authenticated FastAPI controller reads the canonical
workflow through `WorkflowService`, forwards it to the private Node `POST /v1/run`, and
streams NDJSON back without buffering or retries. Relative artifact capabilities are
proxied through FastAPI; disconnecting the caller closes the upstream response.
For batches, FastAPI validates only the strict public envelope, forwards each full Local
or Relay document without persistence-model validation, and buffers at most 1 MiB of the
private JSON response. Creation is sent exactly once.

Dependencies point inward from transport to business behavior to persistence. Pydantic
models are shared by the controller, service, repository, and document store as the
canonical in-process representation. Controllers do not contain lifecycle rules, the
repository does not interpret HTTP requests, and object keys never cross the service
boundary.

Background execution is a sibling Node service rather than another FastAPI layer:

```text
POST /v1/run or /v1/batches (unauthenticated local HTTP)
                             |
               +-------------+-------------+
               |                           |
        direct NDJSON             in-memory FIFO batch
               |                  + safe polling snapshot
               +-------------+-------------+
                             |
                             v
@relay/automation-service-browserbase
 validation | transport | shared capacity | cancellation | thumbnail storage
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

The service accepts complete canonical documents with any string `schemaVersion`, then
the worker owns one
fresh Browserbase session per run. Direct runs accept explicit parameters and stream
progress. Batches queue one to ten workflows in process memory and retain privacy-safe
polling snapshots for one hour. All entry points share a configurable per-process
capacity that defaults to five. Batch state is not durable and disappears on restart.
Neither execution mode shares the Python service's transaction, repository,
authentication, or persistence infrastructure. The version value is opaque metadata
and does not affect admission. Assertions resolve one visible target and evaluate once
in workflow order without retries or post-assertion settling.

For direct and batch work, the Browserbase worker can capture the visible viewport after
automation-core returns and before provider cleanup. The service converts that image to
a bounded WebP under `.relay/artifacts` and exposes an opaque URL from an in-memory
one-hour allowlist. Files persist for manual local inspection, while URL access and all
batch/run metadata disappear on restart. The Inngest path does not request capture.

### Application assembly and cross-cutting behavior

[`src/relay_backend/main.py`](src/relay_backend/main.py) builds the FastAPI application:

- The lifespan handler loads environment-backed settings and opens a Psycopg connection
  pool, an S3-compatible Railway document store, and a non-retrying async automation HTTP
  client with a 30-second read timeout. Tests constructor-inject services and clients
  with an in-memory store and avoid creating production dependencies.
- `RequestBodyLimitMiddleware` runs before routing and enforces the 1 MiB body limit
  from the contract, including streamed bodies without a usable `Content-Length`.
- The workflow router applies shared HTTP Basic authentication to every workflow route.
- Exception handlers translate validation, domain, persistence, and unexpected failures
  into safe contract responses. Unexpected errors log only exception type, HTTP method,
  and path—not workflow content.
- The app serves the checked-in OpenAPI contract rather than FastAPI's generated schema.
  [`src/relay_backend/contract.py`](src/relay_backend/contract.py) loads the repository
  copy during development and the packaged copy from the wheel after installation.
- The app disables FastAPI's built-in Swagger UI and ReDoc pages. `/docs` serves one
  read-only Scalar reference with selectable **Workflow Storage** and **Workflow Runs**
  sources backed by the two checked-in contracts. `/openapi.json` remains the
  persistence contract. Scalar telemetry and browser credential persistence are
  disabled, and the SDK-owned local `/api/inngest` adapter is not presented as a Relay
  API source.

### Layer responsibilities

| Layer | Owns | Must not own |
| --- | --- | --- |
| Controller | Route declarations, headers, path/body binding, response models, and empty-body enforcement. | Transactions, SQL, revision logic, or lifecycle policy. |
| Service | Workflow lifecycle, server-owned fields, revision checks, canonical request hashes, idempotency orchestration, and safe persistence-error mapping. | HTTP response formatting or raw SQL. |
| Database | Connection-pool lifecycle and transaction context. | Domain decisions or query contents. |
| Repository | Parameterized SQL, row locking, metadata/summary/pointer writes, legacy JSONB reads, and idempotency records. | HTTP semantics, object I/O, or workflow lifecycle decisions. |
| Document store | Deterministic serialization, immutable object keys, bounded validated reads, and S3 error mapping. | SQL, revisions, idempotency, or public URLs. |
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

### Namespace and read requests

- Namespace list/get operations select only `id`, `name`, and timestamps. Namespace
  creation uses the shared global idempotency table and never accesses the bucket.
- Nested workflow operations constrain both namespace and workflow IDs; missing scope,
  missing workflow, and ownership mismatch produce one indistinguishable safe `404`.
- `GET .../workflows/{workflowId}` selects the active opaque object key, closes the
  transaction, then reads and validates the canonical object. Rows not yet backfilled
  temporarily fall back to legacy `document` JSONB.
- `GET .../workflows` selects only the precomputed `summary` JSONB values, ordered by
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
6. The document store writes immutable deterministic JSON. The repository publishes its
   opaque key with the safe summary and records the successful idempotency response.
7. The transaction commits all changes together. Any failure rolls back both the
   workflow change and the claimed key, so failed mutations do not consume keys.

The row lock serializes competing writes. Bucket I/O remains inside the mutation
transaction after replay and revision checks. The conditional `UPDATE ... WHERE revision
= expected_revision` adds a compare-and-swap guard; exactly one concurrent writer can
publish a new pointer and advance a revision. A later database rollback can leave only an
unreachable immutable object.

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
| `document_key` | Opaque key for the active immutable canonical object. |
| `document` JSONB | Nullable legacy source retained only during the staged backfill. |
| `summary` JSONB | Precomputed safe projection returned by list operations. |

The relational columns duplicate selected document fields intentionally so the database
can lock, compare, constrain, and order records without reading arbitrary objects. The
document pointer, metadata, summary, and idempotency result are published in one database
transaction after the immutable object write succeeds.

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
│   ├── designs/
│   │   └── inngest-browserbase-orchestration.md
│   └── decisions/
│       ├── 0001-postgresql-jsonb-persistence.md
│       ├── 0002-shared-basic-authentication.md
│       ├── 0003-standalone-typescript-automation-core.md
│       ├── 0004-browserbase-background-worker.md
│       ├── 0005-stateless-browserbase-run-service.md
│       ├── 0006-schema-1.3-assertion-execution.md
│       ├── 0007-in-memory-background-batches.md
│       ├── 0008-unauthenticated-local-execution-service.md
│       ├── 0009-local-terminal-screenshot-artifacts.md
│       ├── 0010-railway-workflow-document-storage.md
│       └── 0011-namespace-scoped-workflows.md
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
│       ├── openapi.yaml               Authoritative execution-service contract
│       ├── README.md                  HTTP, configuration, privacy, and operations
│       ├── src/                       Configuration, HTTP lifecycle, local Inngest POC, and entry point
│       └── tests/                     Contract, streaming, Inngest, lifecycle, integration, and smoke tests
├── migrations/
│   ├── env.py                        Alembic online/offline runtime configuration
│   ├── script.py.mako                Migration revision template
│   └── versions/
│       ├── 0001_initial.py            Workflow and idempotency table definitions
│       ├── 0002_add_namespace_and_record.py  Pre-existing namespace/record schema
│       ├── 0003_add_workflow_document_key.py Object-key staged migration
│       └── 0004_scope_workflows_to_namespaces.py Namespace ownership migration
├── src/
│   └── relay_backend/
│       ├── __init__.py                Package marker
│       ├── main.py                    App factory, lifespan, middleware, error mapping
│       ├── settings.py                Required environment-backed configuration
│       ├── document_store.py          Railway S3 object serialization and transport
│       ├── backfill_workflow_documents.py  Resumable legacy JSONB backfill command
│       ├── auth.py                    Shared Basic authentication dependency
│       ├── request_limits.py          ASGI request-body size enforcement
│       ├── contract.py                Repository/installed OpenAPI contract loader
│       ├── errors.py                  Safe domain and persistence exceptions
│       ├── controllers/
│       │   ├── namespaces.py          Namespace and scoped workflow routes
│       │   └── workflows.py           Deprecated flat workflow routes
│       ├── services/
│       │   ├── namespaces.py          Namespace metadata behavior
│       │   └── workflows.py           Scoped and legacy workflow orchestration
│       ├── data/
│       │   ├── database.py            Psycopg connection pool and transactions
│       │   ├── idempotency_repository.py Shared global mutation identities
│       │   ├── namespace_repository.py Namespace metadata and scope checks
│       │   └── workflow_repository.py Scoped/global SQL and row locking
│       └── models/
│           ├── namespaces.py          Strict namespace API models
│           └── workflows.py           Canonical Pydantic workflow model family
└── tests/
    ├── conftest.py                    Migration and database-cleanup fixtures
    ├── test_api.py                    HTTP, auth, errors, limits, and served contract
    ├── test_backfill.py               Resumable legacy-document migration behavior
    ├── test_document_store.py         S3 serialization, bounds, and safe failures
    ├── test_namespace_api.py          Namespace and scoped workflow HTTP behavior
    ├── test_namespace_migration.py    Ownership migration and invalid-name guard
    ├── test_namespace_service.py      Namespace concurrency behavior
    ├── test_service.py                Transactions, concurrency, privacy, idempotency
    └── test_models.py                 Validation, variants, summaries, schema agreement
```

Empty `__init__.py` files under the controller, service, data, model, and test packages
are package markers and contain no runtime behavior.

## Detailed ownership map

| Path | Responsibility |
| --- | --- |
| [`src/relay_backend/main.py`](src/relay_backend/main.py) | Builds the app, owns dependency lifetime, installs middleware/routes, serves the contract, and maps failures to safe API errors. |
| [`src/relay_backend/settings.py`](src/relay_backend/settings.py) | Declares required database, shared-auth, and private bucket environment settings. |
| [`src/relay_backend/document_store.py`](src/relay_backend/document_store.py) | Defines the constructor-injected document-store protocol and bounded S3 adapter. |
| [`src/relay_backend/backfill_workflow_documents.py`](src/relay_backend/backfill_workflow_documents.py) | Moves legacy JSONB documents to immutable objects without changing workflow metadata. |
| [`src/relay_backend/auth.py`](src/relay_backend/auth.py) | Validates shared credentials with constant-time byte comparisons. |
| [`src/relay_backend/request_limits.py`](src/relay_backend/request_limits.py) | Enforces the 1 MiB request-body limit for declared and streamed body sizes. |
| [`src/relay_backend/contract.py`](src/relay_backend/contract.py) | Selects and parses the repository or packaged OpenAPI document. |
| [`src/relay_backend/errors.py`](src/relay_backend/errors.py) | Defines failures whose messages are safe at the HTTP boundary. |
| [`src/relay_backend/controllers/namespaces.py`](src/relay_backend/controllers/namespaces.py) | Maps namespace and canonical scoped workflow operations to services. |
| [`src/relay_backend/controllers/workflows.py`](src/relay_backend/controllers/workflows.py) | Maps deprecated flat workflow aliases to shared service behavior. |
| [`src/relay_backend/services/namespaces.py`](src/relay_backend/services/namespaces.py) | Implements namespace metadata, ordering, idempotency, and safe conflicts. |
| [`src/relay_backend/services/workflows.py`](src/relay_backend/services/workflows.py) | Implements scoped and legacy lifecycle behavior with shared revision orchestration. |
| [`src/relay_backend/data/database.py`](src/relay_backend/data/database.py) | Owns the Psycopg pool and transaction context manager. |
| [`src/relay_backend/data/idempotency_repository.py`](src/relay_backend/data/idempotency_repository.py) | Claims and completes global idempotency records for every mutation. |
| [`src/relay_backend/data/namespace_repository.py`](src/relay_backend/data/namespace_repository.py) | Executes namespace metadata, default resolution, and scope-check SQL. |
| [`src/relay_backend/data/workflow_repository.py`](src/relay_backend/data/workflow_repository.py) | Executes scoped/global metadata, summary, object-pointer, backfill, and lock SQL. |
| [`src/relay_backend/models/workflows.py`](src/relay_backend/models/workflows.py) | Defines strict camelCase API models, workflow-step variants, safe summaries, and canonical hashing. |
| [`migrations/`](migrations/) | Configures Alembic and stores ordered, reversible database changes. |
| [`tests/test_models.py`](tests/test_models.py) | Proves strict model behavior and OpenAPI schema compatibility. |
| [`tests/test_service.py`](tests/test_service.py) | Proves lifecycle, transaction, concurrency, privacy, ordering, and idempotency behavior against PostgreSQL. |
| [`tests/test_api.py`](tests/test_api.py) | Proves authentication, routes, errors, limits, and served-contract behavior. |
| [`tests/conftest.py`](tests/conftest.py) | Applies migrations once and cleans workflow, idempotency, and non-default namespace test data. |
| [`docs/decisions/`](docs/decisions/) | Preserves the rationale and consequences of accepted architecture/security decisions. |
| [`packages/automation-core/src/workflow.ts`](packages/automation-core/src/workflow.ts) | Defines the strict TypeScript execution contract, opaque schema-version metadata, assertions, and locator ordering. |
| [`packages/automation-core/src/preflight.ts`](packages/automation-core/src/preflight.ts) | Validates runner inputs, start selection, enabled ranges, and bootstrap URL choice. |
| [`packages/automation-core/src/target-resolution.ts`](packages/automation-core/src/target-resolution.ts) | Owns frame selection, locator construction, uniqueness and visibility checks, and recorded element fingerprint validation. |
| [`packages/automation-core/src/step-actions.ts`](packages/automation-core/src/step-actions.ts) | Owns canonical Playwright actions, combobox input fidelity, assertions, and recorded page-position restoration. |
| [`packages/automation-core/src/execution.ts`](packages/automation-core/src/execution.ts) | Owns automatic settling, explicit waits, cancellation-aware step orchestration, and compatibility exports. |
| [`packages/automation-core/src/execution-errors.ts`](packages/automation-core/src/execution-errors.ts) | Defines privacy-safe execution failures, phases, cancellation, and interruptible sleeping shared across execution modules. |
| [`packages/automation-core/src/runner.ts`](packages/automation-core/src/runner.ts) | Runs steps sequentially and returns transport-neutral events and terminal results. |
| [`packages/automation-core/tests/`](packages/automation-core/tests/) | Proves contract agreement, behavior parity, fail-fast execution, cancellation, and diagnostic privacy. |
| [`packages/automation-worker-browserbase/src/`](packages/automation-worker-browserbase/src/) | Validates complete run inputs, resolves parameters, owns Browserbase lifecycle, and exposes the JSONL CLI. |
| [`packages/automation-worker-browserbase/tests/`](packages/automation-worker-browserbase/tests/) | Proves worker lifecycle, cleanup, timeout, parameter, CLI, and privacy behavior without paid sessions by default. |
| [`packages/automation-service-browserbase/openapi.yaml`](packages/automation-service-browserbase/openapi.yaml) | Defines the independent direct-run, in-memory batch, polling, and health wire contract. |
| [`packages/automation-service-browserbase/src/`](packages/automation-service-browserbase/src/) | Owns media validation, request limits, NDJSON and batch transport, shared local capacity, disconnect cancellation, and shutdown. |
| [`packages/automation-service-browserbase/src/inngest.ts`](packages/automation-service-browserbase/src/inngest.ts) | Owns the opt-in local Inngest event validation, one-function registration, and safe terminal projection. |
| [`packages/automation-service-browserbase/tests/`](packages/automation-service-browserbase/tests/) | Proves the service contract and worker integration without paid sessions by default. |
| [`docs/designs/inngest-browserbase-orchestration.md`](docs/designs/inngest-browserbase-orchestration.md) | Defines the local-only Inngest POC boundary and deferred production decisions. |

## Where to make common changes

| Change | Start here | Also inspect or update |
| --- | --- | --- |
| Add or change an API route | [`openapi.yaml`](openapi.yaml) | Controller, service, API tests, and packaged-contract behavior. |
| Change workflow or step fields | [`openapi.yaml`](openapi.yaml) and [`models/workflows.py`](src/relay_backend/models/workflows.py) | Model tests, request hashing, summaries, and schema-version policy. |
| Change lifecycle or revision behavior | [`services/workflows.py`](src/relay_backend/services/workflows.py) | OpenAPI mutation semantics and service concurrency tests. |
| Change idempotency semantics | [`services/workflows.py`](src/relay_backend/services/workflows.py) and [`workflow_repository.py`](src/relay_backend/data/workflow_repository.py) | Schema, contract text, replay/conflict tests, and possibly a new ADR. |
| Change stored data or indexes | [`migrations/versions/`](migrations/versions/) | Repository SQL, downgrade behavior, tests, and ADR 0001. |
| Change canonical document storage | [`document_store.py`](src/relay_backend/document_store.py) | Service transactions, settings, migration/backfill behavior, privacy tests, and ADR 0010. |
| Change list output | `WorkflowSummary` and `to_workflow_summary` in [`models/workflows.py`](src/relay_backend/models/workflows.py) | Repository list query, OpenAPI schemas, and privacy assertions. |
| Change authentication | [`auth.py`](src/relay_backend/auth.py) | Settings, OpenAPI security, API tests, and ADR 0002. |
| Change the direct or batch run gateway | [`controllers/runs.py`](src/relay_backend/controllers/runs.py) | Root OpenAPI, gateway tests, deployment settings, and ADR 0013. |
| Change error behavior | [`errors.py`](src/relay_backend/errors.py) and [`main.py`](src/relay_backend/main.py) | OpenAPI responses and safe-error tests. |
| Change request-size limits | [`request_limits.py`](src/relay_backend/request_limits.py) | `x-contract-semantics`, request-body docs, and boundary tests. |
| Add configuration | [`settings.py`](src/relay_backend/settings.py) | [`.env.example`](.env.example), README configuration table, and tests. |
| Change packaging or dependencies | [`pyproject.toml`](pyproject.toml) | `uv.lock`, contract packaging, and README requirements. |
| Change background automation behavior | [`packages/automation-core/src/runner.ts`](packages/automation-core/src/runner.ts), [`step-actions.ts`](packages/automation-core/src/step-actions.ts), [`target-resolution.ts`](packages/automation-core/src/target-resolution.ts), and [`execution.ts`](packages/automation-core/src/execution.ts) | Package tests, public exports, package README, and ADR 0003 boundaries. |
| Change Browserbase run lifecycle | [`packages/automation-worker-browserbase/src/worker.ts`](packages/automation-worker-browserbase/src/worker.ts) | Worker tests, CLI output, package README, and ADR 0004 boundaries. |
| Change the Browserbase execution API | [`packages/automation-service-browserbase/openapi.yaml`](packages/automation-service-browserbase/openapi.yaml) | Service runtime, tests, README, and ADR 0005/0007/0008 boundaries. |
| Change the local Inngest POC | [`packages/automation-service-browserbase/src/inngest.ts`](packages/automation-service-browserbase/src/inngest.ts) | Shared lifecycle tests, package README, POC design, and privacy assertions. |

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
- Immutable canonical objects are written before their pointer, safe summary, revision,
  and idempotency result are published in one PostgreSQL transaction. Rolled-back writes
  may leave only unreachable objects.
- List queries never load or expose workflow payloads, targets, parameter values, or
  source session IDs.
- Errors and logs never include workflow bodies, credentials, object keys, or other
  persistence details.
- The authenticated direct gateway does not buffer or retry execution and closes upstream
  streams on disconnect. The batch gateway never retries creation and buffers at most
  1 MiB before responding. Both forward only safe response headers and never log workflow
  bodies, parameter values, batch IDs, artifact IDs, artifact URLs, or private URLs.
- Runtime SQL remains parameterized.
- Request bodies larger than 1 MiB are rejected whether or not `Content-Length` is
  present or valid.
- The automation core accepts an existing Playwright `Page`; it does not create or
  persist browser sessions, call Browserbase, or depend on FastAPI/PostgreSQL.
- Automation events, terminal results, and thrown execution diagnostics exclude action
  payloads, target and locator values, URLs, workflow bodies, and source session IDs.
- The Browserbase worker accepts complete workflows regardless of the declared schema
  version, never reuses the
  recorded source session, never retries actions, and always attempts session cleanup.
- Assertions evaluate once, emit `asserting`, never settle afterward, and never expose
  expected or observed text in diagnostics.
- Worker JSONL excludes workflow bodies, URLs, payloads, parameter values, connection
  details, provider session IDs, and raw errors.
- The run service accepts only full request-scoped workflows; it never reads or writes
  PostgreSQL and never calls the persistence API.
- Run-service HTTP routes are intentionally unauthenticated for this POC and default to
  loopback. Request/header logging remains disabled. All stream lines contain only a
  generated run ID plus safe worker or service fields.
- A valid stream contains exactly one terminal outcome. Disconnect and shutdown abort
  the worker; direct and Inngest capacity exhaustion returns `429` without queueing.
- Batch runs use one bounded FIFO process-local queue and explicit safe polling
  projections. Batch, direct, and Inngest work never exceed the shared configured
  capacity; shutdown aborts active work and starts no queued work.
- Batch workflow inputs are released after their run settles. Terminal snapshots expire
  after one hour, no active batch is evicted, and all batch state is lost on restart.

## Configuration, packaging, and local dependencies

- [`Settings`](src/relay_backend/settings.py) requires `DATABASE_URL`,
  `BASIC_AUTH_USERNAME`, `BASIC_AUTH_PASSWORD`, `BUCKET`, `ENDPOINT`, `ACCESS_KEY_ID`,
  `SECRET_ACCESS_KEY`, and `REGION`. Tests constructor-inject an in-memory document store
  and optionally use `TEST_DATABASE_URL` directly from fixture configuration.
- `AUTOMATION_SERVICE_URL` selects the private run-service base URL and defaults to
  `http://127.0.0.1:8080` for local development.
- Remote deployments use the Railway private domain, keep screenshots disabled initially,
  and run exactly one automation-service replica because all batch and artifact access
  state is process-local.
- The Browserbase worker reads `BROWSERBASE_API_KEY` for real runs and optionally
  `BROWSERBASE_PROJECT_ID`, `BROWSERBASE_REGION`, `BROWSERBASE_USE_PROXY`, and
  `BROWSERBASE_VERIFIED`. Validation-only CLI use does not require credentials.
- The run service reads listen, capacity, deadline, and shutdown settings from the
  process environment, defaults its host to `127.0.0.1`, requires no service token, and
  does not load another repository's environment files.
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
- Run-gateway API tests use an in-process HTTP transport to prove UUID resolution,
  byte-for-byte streaming, safe header/error forwarding, and artifact-log privacy.
- Automation package tests are pure TypeScript tests. They exercise schema/preflight,
  all nine Playwright actions, locator/frame behavior, settling and waits,
  cancellation, sequential fail-fast execution, and privacy-safe diagnostics.
- Browserbase worker tests use provider and browser fakes. A navigation-only paid smoke
  test runs only when `BROWSERBASE_E2E=1` is set explicitly.
- Run-service tests exercise unauthenticated HTTP streaming, media negotiation, capacity, disconnect,
  shutdown, and the real worker with provider fakes. Its HTTP Browserbase smoke test is
  gated by the same explicit `BROWSERBASE_E2E=1` opt-in.

## POC boundaries

The FastAPI service intentionally excludes user accounts, tenants, ownership rules,
pagination, deletion, workflow-schema migration, collaboration, replay execution,
local-file mirroring, application-level encryption, production deployment configuration,
and idempotency-record expiry. The automation library intentionally excludes browser
and Browserbase lifecycle, jobs, schedules, service APIs, authentication, execution
persistence, retries, recording, and interactive replay controls. HTTP Basic must be
placed behind TLS if the service is exposed beyond localhost.
The Browserbase worker excludes queues, schedules, and durable run records. Its sibling
HTTP service adds only a bounded process-local batch queue and safe polling snapshots;
it still excludes durable execution, scheduling, idempotency, reconnection, user
authorization, legacy workflow migration, authenticated contexts, and automatic retries.
The execution service defaults to loopback and is not safe to expose publicly because
its routes are unauthenticated.

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
- [`ADR 0006: Require schema 1.3 for background execution`](docs/decisions/0006-schema-1.3-assertion-execution.md)
- [`ADR 0007: Add in-memory background batches`](docs/decisions/0007-in-memory-background-batches.md)
- [`ADR 0008: Unauthenticated local execution service`](docs/decisions/0008-unauthenticated-local-execution-service.md)
- [`ADR 0009: Local terminal screenshot artifacts`](docs/decisions/0009-local-terminal-screenshot-artifacts.md)
- [`ADR 0010: Railway workflow document storage`](docs/decisions/0010-railway-workflow-document-storage.md)
- [`ADR 0012: Treat execution schema versions as opaque`](docs/decisions/0012-opaque-execution-schema-version.md)
- [`ADR 0013: Add an authenticated direct and batch workflow gateway`](docs/decisions/0013-authenticated-workflow-run-gateway.md)

When a decision changes, add a new sequential record that supersedes the older one.
Preserve accepted historical records rather than rewriting or deleting their rationale.
