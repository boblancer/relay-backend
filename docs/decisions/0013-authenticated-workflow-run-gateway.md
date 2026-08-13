# ADR-013: Add an authenticated direct and batch workflow gateway

## Status

Accepted

## Date

2026-08-13

## Context

Callers know the UUID of a persisted workflow but the private Browserbase service accepts
only complete workflow documents. No separate BFF or proxy exists in this deployment.
Teaching the Node service to read persistence would reverse its stateless boundary and
duplicate the Python service's document lookup and authentication responsibilities.

Direct runs can last ten minutes, while batch creation can enqueue several workflows
whose browser actions are non-idempotent. Both can return sensitive temporary thumbnail
capabilities. The gateway must preserve direct streaming and cancellation, avoid uncertain
batch retries, and keep the unauthenticated Node service private.

## Decision

Add authenticated `POST /v1/run-by-id` to FastAPI. It loads the workflow through the
existing global UUID lookup, constructs the established direct-run JSON request, and
streams the private Node `POST /v1/run` response without buffering or retrying it. Optional
run settings remain optional, and Node preflight remains authoritative for executability.

Add authenticated `POST /v1/batches` and `GET /v1/batches/{batchId}` to FastAPI. Creation
accepts the private service's strict one-to-ten-run envelope but treats every enclosed
workflow as opaque JSON. This permits full Local-workspace and Relay workflow documents
without coupling executable-workflow admission to Python's persistence schema. Forward
creation exactly once. Buffer creation and polling responses up to 1 MiB so connection,
timeout, protocol, and read failures can become a safe `503 automation_unavailable`
before public response headers begin.

Add authenticated `GET /v1/artifacts/{artifactId}` so relative terminal thumbnail URLs
remain usable through the public boundary. Forward only explicitly allowlisted response
headers. Never log workflow bodies, parameters, batch IDs, artifact IDs, or artifact URLs.
Apply a 30-second upstream read timeout, which remains above the private service's
15-second direct-run heartbeat interval, and use a bounded timeout for artifacts.

Configure the private upstream with `AUTOMATION_SERVICE_URL`, defaulting to loopback for
local development. Keep the Node service unauthenticated and privately networked. This
record supersedes ADR 0005 only where it keeps FastAPI completely unchanged and
persistence-only; the separate stateless execution process, no-retry policy, capacity,
privacy, cancellation, and terminal-stream decisions remain accepted.
Operate exactly one private Node replica because batch records, polling snapshots, and
thumbnail allowlists are process-local.

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

Batch responses are buffered because they are bounded JSON rather than live progress
streams; this allows transport failures to be translated before the public response starts.

## Consequences

- Callers can execute a stored workflow using only its UUID and optional run settings.
- Callers can submit and poll batches containing complete Local or Relay workflow documents
  without exposing the private automation service.
- FastAPI becomes an authenticated streaming gateway but still does not execute browser
  actions or persist run state.
- The global workflow lookup remains a compatibility dependency until a future
  namespace-aware run contract replaces it.
- An upstream outage returns a privacy-safe `503 automation_unavailable`; upstream
  contract rejections otherwise pass through unchanged.
- Deployments must configure private network reachability from FastAPI to Node and must
  not add automatic retries or additional Node replicas.
