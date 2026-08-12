# Namespace-Scoped Workflow Persistence Plan

- Status: Implemented
- Repository: `relay_backend`
- Intended delivery: a separate PR after the Railway document-store refactor
- Contract owner: `openapi.yaml`

## Objective

Add organizational namespaces around workflow persistence without changing canonical
workflow documents or object storage. A workflow belongs to exactly one namespace,
namespace-scoped routes become the canonical API, and PostgreSQL enforces membership.

The change must preserve workflow revision, idempotency, privacy, summary-only list,
and immutable document-store behavior. Existing clients receive one compatibility
release in which the five current flat workflow operations remain available as
deprecated aliases.

## Assumptions

1. Namespaces are organizational containers, not authentication or tenant boundaries.
   The existing shared HTTP Basic credentials continue authorizing every namespace.
2. Namespace IDs use UUIDs because migration `0002` already created the
   `namespaces` table with a UUID primary key.
3. Every workflow belongs to exactly one namespace after migration `0004` completes.
4. Existing workflows are assigned to a `Default` namespace without changing their
   revision, timestamps, status, summary, document key, or idempotency records.
5. Namespace creation, listing, and lookup are sufficient for the first namespace PR.
   Rename, deletion, transfer between namespaces, pagination, and per-namespace auth
   are deferred.
6. The current flat workflow routes remain deprecated aliases for one release. Flat
   creation targets `Default`; flat reads and mutations preserve their current global
   workflow-ID behavior.
7. Bucket keys remain `workflows/{workflow_id}/{revision}-{sha256}.json`; namespace
   assignment never copies or rewrites canonical objects.

## HTTP Contract

Update only `openapi.yaml`; do not add another OpenAPI document.

### Namespace operations

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/v1/namespaces` | List namespace metadata ordered by name, then ID. |
| `POST` | `/v1/namespaces` | Create a namespace using a global idempotency key. |
| `GET` | `/v1/namespaces/{namespaceId}` | Return namespace metadata or safe `404`. |

Namespace responses contain only `id`, `name`, `createdAt`, and `updatedAt`. Names are
trimmed, 1–100 characters, and globally unique using the database's existing exact
text uniqueness rule. Duplicate creation returns a safe `409`.

### Canonical namespace-scoped workflow operations

| Existing operation | Canonical route |
| --- | --- |
| `listWorkflows` | `GET /v1/namespaces/{namespaceId}/workflows` |
| `createWorkflow` | `POST /v1/namespaces/{namespaceId}/workflows` |
| `getWorkflow` | `GET /v1/namespaces/{namespaceId}/workflows/{workflowId}` |
| `saveWorkflow` | `PUT /v1/namespaces/{namespaceId}/workflows/{workflowId}` |
| `finishWorkflow` | `POST /v1/namespaces/{namespaceId}/workflows/{workflowId}/finish` |

All request and response bodies remain unchanged. A missing namespace and a workflow
that belongs to another namespace both return the same safe `404`; callers cannot use
the API to probe cross-namespace membership.

The current flat `/v1/workflows` routes remain in `openapi.yaml` with
`deprecated: true`. Controllers delegate both route shapes to the same service methods
so revision and idempotency behavior cannot diverge. Remove these aliases only in a
later, explicitly breaking contract change.

The nested routes own the existing workflow operation IDs. Deprecated flat aliases use
distinct `legacy...` operation IDs. Idempotency identity continues using the literal
method and path, so reuse across nested and flat route shapes conflicts rather than
replaying.

## Data Model and Migration

Add sequential migration `0004`; never edit migrations `0001`–`0003`.

1. Reuse the existing `namespaces` table created by `0002`.
2. Refuse migration when existing namespace names are untrimmed, blank, or longer than
   100 characters, then add a database check for that contract.
3. Add nullable UUID `workflows.namespace_id` with a foreign key to `namespaces.id`
   using `ON DELETE RESTRICT`.
4. Reuse an existing namespace named `Default`, or insert it if absent.
5. Assign every unscoped workflow to `Default` in one SQL migration without touching
   any other workflow column.
6. Make `workflows.namespace_id` non-null and add an index beginning with
   `namespace_id`; retain the existing `updated_at DESC` index.
7. Leave the unused `records` table from `0002` unchanged. Removing it is a separate
   cleanup migration after confirming no external dependency.

Downgrade removes only the workflow namespace foreign key, index, and column. It does
not delete namespace rows or the pre-existing `namespaces`/`records` tables.

## Architecture and Refactor

```text
namespace/workflow controllers
            |
            v
      namespace-aware services
       membership + lifecycle
          +---------+
          |         |
          v         v
 namespace repo   workflow repo ----> private Railway bucket
          |         |
          +----+----+
               v
          PostgreSQL
```

- Add strict namespace API models under `models/namespaces.py`.
- Add a small `NamespaceRepository` and `NamespaceService` for metadata operations.
- Extract global idempotency persistence from `WorkflowRepository` into a reusable
  repository so namespace creation follows the same replay/conflict rules.
- Pass `namespace_id` explicitly through workflow controllers, service methods, and
  repository queries. Nested reads, locks, and updates constrain both IDs in SQL.
- Extend workflow inserts with `namespace_id`; never add namespace fields to the
  canonical `Workflow` document stored in the bucket.
- Add `list_summaries(namespace_id)` that still selects only `summary`; listing must
  never call `WorkflowDocumentStore.get`.
- Keep required constructor injection in `main.py`; assemble both services from the
  same `Database` and shared repositories. Do not add a DI framework.
- Route aliases must share service code. Do not duplicate transaction, revision, or
  document-store orchestration in controllers.

## Code Style

Use explicit UUID scope at every layer and named keyword arguments at call sites:

```python
workflow = service.save(
    namespace_id=namespace_id,
    workflow_id=workflow_id,
    request=body,
    idempotency_key=idempotency_key,
)
```

Keep SQL parameterized, Pydantic models strict, controllers thin, and persistence
errors translated through the existing safe error envelope.

## Testing Strategy

Write failing tests before each behavior change.

- Contract tests: new namespace schemas/routes, deprecated flat aliases, unchanged
  workflow bodies, and OpenAPI validation.
- Namespace API tests: authentication, validation, duplicate names, exact replay,
  conflicting idempotency reuse, safe `404`, and persistence failures.
- Workflow service tests: namespace-scoped create/list/get/save/finish, wrong-namespace
  `404`, stale revisions, exact replay, concurrent writes, and global idempotency.
- Privacy tests: namespace listing contains metadata only; workflow listing still reads
  summaries only; responses/logs never contain document keys or workflow values.
- Object-store tests: namespace operations perform no bucket calls; assigning scope
  does not alter object keys; stale or cross-namespace mutations write no object.
- Migration tests: upgrade a populated `0003` database, preserve all workflow fields,
  assign every row, enforce the foreign key/non-null constraint, and downgrade safely.
- Compatibility tests: every current flat HTTP test remains unchanged; add nested-route
  equivalents that assert identical responses and mutation semantics.

## Commands

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

## Boundaries

### Always

- Preserve atomic revision comparison/mutation and exactly-one revision increments.
- Keep idempotency keys global and failed mutations non-consuming.
- Constrain nested workflow reads and writes by both namespace and workflow ID.
- Keep list queries summary-only and bucket keys private.
- Update `openapi.yaml`, runtime models/controllers, tests, README, and NAVIGATION
  together.
- Add ADR-011 for namespace ownership, compatibility aliases, and migration behavior.

### Ask first

- Removing the deprecated flat routes.
- Adding namespace rename, deletion, or workflow transfer.
- Changing exact name uniqueness to case-insensitive uniqueness.
- Dropping the existing `records` table.

### Never

- Put namespace metadata inside canonical workflow objects.
- Use the Railway Volume or add file upload/download endpoints.
- Create a second namespace OpenAPI contract.
- Cascade namespace deletion into workflows or bucket objects.
- Expose object keys, credentials, workflow bodies, or cross-namespace existence.

## Rollout

1. Deploy migration `0004`, namespace services, nested routes, and flat aliases
   together.
2. Verify every workflow has a namespace and existing flat clients still pass.
3. Move the recorder/BFF to namespace-scoped routes.
4. Observe usage through privacy-safe route metrics only.
5. Remove flat aliases in a later breaking-contract PR after caller migration.

## Success Criteria

- All existing workflows belong to `Default` with no canonical-object rewrite and no
  metadata or revision change.
- Namespace create/list/get and all five nested workflow operations match the checked-in
  contract.
- A workflow can be read or mutated only through its owning namespace on nested routes.
- Flat workflow operations remain behaviorally unchanged and are marked deprecated.
- Exact replays perform no extra database mutation or bucket write; stale and
  wrong-namespace mutations write nothing.
- List endpoints never load canonical workflow objects.
- All repository-standard verification commands pass.

## Approval

Approved and implemented with a one-release flat-route compatibility window and
deferred rename/delete/transfer operations.
