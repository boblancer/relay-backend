# Namespace-Scoped Workflow Persistence Tasks

- [x] Task 1: Approve the namespace contract and compatibility window.
  - Acceptance: UUID identity, minimal namespace operations, nested canonical routes,
    default namespace behavior, and deprecated flat aliases are approved.
  - Verify: Human approval of `tasks/plan.md`.
  - Files: `tasks/plan.md`

- [x] Task 2: Specify the public contract and namespace models with failing tests.
  - Acceptance: `openapi.yaml` defines namespace create/list/get, five nested workflow
    operations, safe errors, and deprecated flat aliases; strict Pydantic models match.
  - Verify: `uv run pytest tests/test_namespace_api.py tests/test_models.py && uv run python -m openapi_spec_validator openapi.yaml`
  - Files: `openapi.yaml`, `src/relay_backend/models/namespaces.py`,
    `tests/test_namespace_api.py`, `tests/test_models.py`

- [x] Task 3: Add and verify migration `0004`.
  - Acceptance: Existing workflows are assigned to `Default`; `namespace_id` becomes a
    non-null indexed UUID foreign key; workflow metadata and object pointers are
    byte-for-byte unchanged apart from the new column.
  - Verify: Focused migration test upgrades a populated `0003` database, checks
    constraints and preservation, then downgrades.
  - Files: `migrations/versions/0004_scope_workflows_to_namespaces.py`,
    `tests/test_namespace_migration.py`, `tests/conftest.py`

- [x] Task 4: Implement namespace metadata persistence and global idempotency reuse.
  - Acceptance: Namespace create/list/get uses parameterized SQL, safe failures, exact
    replay, conflicting reuse `409`, and no bucket access.
  - Verify: `uv run pytest tests/test_namespace_service.py tests/test_namespace_api.py`
  - Files: `src/relay_backend/data/namespace_repository.py`,
    `src/relay_backend/data/idempotency_repository.py`,
    `src/relay_backend/services/namespaces.py`, `tests/test_namespace_service.py`,
    `tests/test_namespace_api.py`

- [x] Task 5: Make workflow persistence namespace-aware.
  - Acceptance: Repository list/read/lock/insert/update operations accept namespace
    scope; wrong-namespace access is a safe `404`; revision, summary, pointer, and
    idempotency invariants remain unchanged.
  - Verify: `uv run pytest tests/test_service.py tests/test_namespace_service.py`
  - Files: `src/relay_backend/data/workflow_repository.py`,
    `src/relay_backend/services/workflows.py`, `tests/test_service.py`,
    `tests/fakes.py`

- [x] Task 6: Add namespace and nested workflow controllers through shared services.
  - Acceptance: New routes authenticate and match OpenAPI; flat aliases retain all
    existing HTTP behavior; controllers contain no duplicated business logic.
  - Verify: `uv run pytest tests/test_api.py tests/test_namespace_api.py`
  - Files: `src/relay_backend/controllers/namespaces.py`,
    `src/relay_backend/controllers/workflows.py`, `src/relay_backend/main.py`,
    `tests/test_api.py`, `tests/test_namespace_api.py`

- [x] Task 7: Record the architecture and rollout.
  - Acceptance: ADR-011 records namespace ownership, UUID reuse, default backfill,
    compatibility aliases, and deferred destructive operations; explanatory docs match.
  - Verify: Review docs against `openapi.yaml` and `NAVIGATION.md` source-of-truth order.
  - Files: `docs/decisions/0011-namespace-scoped-workflows.md`, `README.md`,
    `NAVIGATION.md`, `AGENTS.md`

- [x] Task 8: Complete privacy, concurrency, compatibility, and migration review.
  - Acceptance: Cross-namespace probes are indistinguishable from missing resources;
    list paths make no object-store calls; exact replay/stale/concurrent behavior matches
    the flat API; no credentials, keys, or workflow values appear in output or logs.
  - Verify: Run every command in `tasks/plan.md`, inspect the final diff, and complete a
    multi-axis code review before opening the namespace PR.
  - Files: focused tests only; no planned production scope expansion
