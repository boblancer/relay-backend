# Backend Tasks: In-Memory Background Batch API

- [x] Task 1: Approve the backend plan and assumptions.
  - Acceptance: Batch ownership, polling contract, limits, retention, and non-goals are accepted.
  - Verify: Human approval of `tasks/background-batch-api-plan.md`.
  - Files: `tasks/background-batch-api-plan.md`

- [x] Task 2: Record the in-memory batch architecture.
  - Acceptance: ADR 0007 supersedes only the stateless/no-result-lookup portions of ADR 0005 and preserves privacy, worker, and no-retry decisions. ADR 0008 later supersedes its authentication decision.
  - Verify: Review the ADR against `docs/decisions/0005-stateless-browserbase-run-service.md`.
  - Files: `docs/decisions/0007-in-memory-background-batches.md`

- [x] Task 3: Specify coordinator behavior with failing tests.
  - Acceptance: Tests cover FIFO five-slot dispatch, safe progress, failure continuation, retention, capacity, input release, and shutdown.
  - Verify: `npm test --prefix packages/automation-service-browserbase`
  - Files: `packages/automation-service-browserbase/tests/batches.test.ts`, `packages/automation-service-browserbase/tests/fixtures.ts`

- [x] Task 4: Implement the transport-neutral batch coordinator.
  - Acceptance: One coordinator owns private inputs and safe snapshots, fills available shared run slots, and releases each input at terminal completion.
  - Verify: `npm test --prefix packages/automation-service-browserbase && npm run typecheck --prefix packages/automation-service-browserbase`
  - Files: `packages/automation-service-browserbase/src/batches/batch-coordinator.ts`, `packages/automation-service-browserbase/tests/batches.test.ts`

- [x] Task 5: Specify and implement batch HTTP routes.
  - Acceptance: Unauthenticated `POST /v1/batches` returns `202`; unauthenticated `GET /v1/batches/{batchId}` returns a safe snapshot; invalid/expired requests use safe errors.
  - Verify: `npm test --prefix packages/automation-service-browserbase`
  - Files: `packages/automation-service-browserbase/src/app.ts`, `packages/automation-service-browserbase/tests/app.test.ts`, `packages/automation-service-browserbase/tests/batches.test.ts`

- [x] Task 6: Unify direct-run and batch capacity/lifecycle behavior.
  - Acceptance: Direct and batch work cannot exceed configured capacity; shutdown aborts active work and starts no queued work.
  - Verify: `npm test --prefix packages/automation-service-browserbase`
  - Files: `packages/automation-service-browserbase/src/app.ts`, `packages/automation-service-browserbase/src/batches/batch-coordinator.ts`, `packages/automation-service-browserbase/tests/lifecycle.test.ts`

- [x] Task 7: Synchronize the public contract and explanatory documentation.
  - Acceptance: OpenAPI, README, NAVIGATION, and ADR agree on request shapes, polling fields, privacy, limits, retention, and restart loss.
  - Verify: `uv run python -m openapi_spec_validator packages/automation-service-browserbase/openapi.yaml`
  - Files: `packages/automation-service-browserbase/openapi.yaml`, `packages/automation-service-browserbase/README.md`, `NAVIGATION.md`, `docs/decisions/0007-in-memory-background-batches.md`

- [x] Task 8: Add worker integration and privacy coverage.
  - Acceptance: Two provider-faked workflows execute through the batch API and no protected workflow/provider values appear in responses or logs.
  - Verify: `npm test --prefix packages/automation-service-browserbase`
  - Files: `packages/automation-service-browserbase/tests/integration.test.ts`, `packages/automation-service-browserbase/tests/fixtures.ts`

- [x] Task 9: Complete backend verification and quality review.
  - Acceptance: Typecheck, tests, build, package dry-run, OpenAPI validation, and code review pass without unrelated changes.
  - Verify: `npm run typecheck --prefix packages/automation-service-browserbase && npm test --prefix packages/automation-service-browserbase && npm run build --prefix packages/automation-service-browserbase && npm pack --dry-run ./packages/automation-service-browserbase && uv run python -m openapi_spec_validator packages/automation-service-browserbase/openapi.yaml`
  - Files: no planned source changes
