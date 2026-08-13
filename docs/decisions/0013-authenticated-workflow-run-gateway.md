# ADR-013: Add an authenticated workflow run gateway

## Status

Accepted

## Date

2026-08-13

## Context

Callers know the UUID of a persisted workflow but the private Browserbase service accepts
only complete workflow documents. No separate BFF or proxy exists in this deployment.
Teaching the Node service to read persistence would reverse its stateless boundary and
duplicate the Python service's document lookup and authentication responsibilities.

Direct runs can last ten minutes, perform non-idempotent external actions, and return
sensitive temporary thumbnail capabilities. The gateway must preserve streaming and
cancellation while keeping the unauthenticated Node service private.

## Decision

Add authenticated `POST /v1/run-by-id` to FastAPI. It loads the workflow through the
existing global UUID lookup, constructs the established direct-run JSON request, and
streams the private Node `POST /v1/run` response without buffering or retrying it. Optional
run settings remain optional, and Node preflight remains authoritative for executability.

Add authenticated `GET /v1/artifacts/{artifactId}` so relative terminal thumbnail URLs
remain usable through the public boundary. Forward only explicitly allowlisted response
headers. Never log workflow bodies, parameters, artifact IDs, or artifact URLs.

Configure the private upstream with `AUTOMATION_SERVICE_URL`, defaulting to loopback for
local development. Keep the Node service unauthenticated and privately networked. This
record supersedes ADR 0005 only where it keeps FastAPI completely unchanged and
persistence-only; the separate stateless execution process, no-retry policy, capacity,
privacy, cancellation, and terminal-stream decisions remain accepted.

## Alternatives considered

### Resolve workflows in the Node service

Rejected because it would add persistence credentials, storage authentication, and
document lookup policy to the execution process.

### Add a separate proxy service

Rejected because this deployment has no BFF and FastAPI already owns authenticated
workflow retrieval.

### Return a buffered JSON result

Rejected because it would lose progress and heartbeat delivery, weaken disconnect
cancellation, and expose long runs to proxy idle timeouts.

## Consequences

- Callers can execute a stored workflow using only its UUID and optional run settings.
- FastAPI becomes an authenticated streaming gateway but still does not execute browser
  actions or persist run state.
- The global workflow lookup remains a compatibility dependency until a future
  namespace-aware run contract replaces it.
- An upstream outage returns a privacy-safe `503 automation_unavailable`; upstream
  contract rejections otherwise pass through unchanged.
- Deployments must configure private network reachability from FastAPI to Node and must
  not add automatic retries.
