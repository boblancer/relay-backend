# Browser Handoff: Remote Batch Automation Gateway

## Objective

Update the browser automation client to use the authenticated public Relay API for batch
creation, polling, and terminal thumbnail retrieval. Do not call or expose the private
automation service directly.

The backend gateway is implemented in `relay_backend`. This handoff describes the
remaining browser-side integration work; it does not authorize changes to the backend's
wire contract.

## Network and authentication boundary

```text
Browser client
  | HTTPS + Relay HTTP Basic credentials
  v
Public Relay API
  | Railway private network, no service authentication
  v
Private relay-automation service
```

- Set the browser client's automation origin from `RELAY_API_BASE_URL`.
- Send the Relay API's HTTP Basic username and password on every batch creation, polling,
  and artifact request.
- Remove `AUTOMATION_SERVICE_TOKEN` from browser configuration and request construction.
  It is obsolete and must not be sent to the Relay API or the private automation service.
- Never configure the browser with the Railway private automation-service domain.
- Keep `relay-automation` private and unauthenticated. Only the public Relay API performs
  caller authentication.

## Public batch API

### Create a batch

Send the existing full-document envelope to the public Relay API:

```http
POST {RELAY_API_BASE_URL}/v1/batches
Authorization: Basic <base64 Relay username:password>
Accept: application/json
Content-Type: application/json
```

```json
{
  "runs": [
    { "workflow": {} }
  ]
}
```

Requirements:

- Send between one and ten runs.
- Each run object contains exactly one `workflow` property.
- Forward each complete Local or Relay workflow document without converting it to the
  Python persistence schema or dropping workspace-specific fields.
- Keep the complete request at or below 1 MiB.
- Treat `202 Accepted` with `{ "batchId": "<uuid>", "runCount": <number> }` as the only
  accepted creation outcome.
- Do not automatically retry creation after a connection error, timeout, `5xx`, or
  ambiguous client cancellation. The private service may have accepted the batch even
  when the browser did not receive the response, and retrying could execute browser
  actions twice.
- Disable or otherwise guard the initiating UI control while one submission is in flight.

### Poll a batch

Poll the returned UUID through the same public Relay origin and Basic credentials:

```http
GET {RELAY_API_BASE_URL}/v1/batches/{batchId}
Authorization: Basic <base64 Relay username:password>
Accept: application/json
```

Handle run statuses as follows:

- `queued`: accepted but not yet executing;
- `running`: executing; optional numeric progress and phase fields may change between
  polls;
- `completed`: terminal success; optional `durationMs` and `thumbnail` may be present;
- `failed`: terminal failure; optional safe `code`, `failedStepId`, and
  `failedStepIndex` may be present.

Continue polling while any run is `queued` or `running`. Stop when every run is
`completed` or `failed`. Batch state is process-local and may disappear after a private
service restart or its retention window expires.

### Retrieve a thumbnail

Treat `thumbnail.url` as an opaque relative capability such as
`/v1/artifacts/{artifactId}`. Resolve it against `RELAY_API_BASE_URL` and send the same
Relay HTTP Basic credentials. Do not resolve it against the private service, log it, or
persist it beyond the browser's immediate display needs.

## Expected failures

- `401`: Relay HTTP Basic credentials are missing or invalid. Do not contact a different
  service or fall back to `AUTOMATION_SERVICE_TOKEN`.
- `400`: the public request shape or batch UUID is invalid; fix the client request and do
  not retry unchanged.
- `413`: the batch request exceeds 1 MiB; reduce the selected workflows and require an
  explicit new submission.
- `404` while polling: the batch is unknown, expired, or was lost during a private service
  restart. Treat it as terminally unavailable rather than recreating it automatically.
- `429`: the private service is at capacity. Surface the safe error and any `Retry-After`
  guidance, but require an explicit new creation attempt because automatic POST retries
  are unsafe.
- `500` or `503 automation_unavailable`: surface a safe temporary failure. Never expose
  response internals, private URLs, workflow documents, parameter values, batch IDs, or
  artifact IDs in logs.
- Timeout or protocol failure: stop the request safely. Polling GETs may be retried under
  the browser's normal bounded polling policy; batch-creation POSTs must not be retried.

## Browser acceptance checks

1. Configure only `RELAY_API_BASE_URL` and Relay HTTP Basic credentials; confirm
   `AUTOMATION_SERVICE_TOKEN` is absent from configuration and outgoing requests.
2. Confirm unauthenticated creation and polling receive `401` from the Relay API.
3. Submit one complete Local workflow and verify the Relay API returns `202`, polling
   reaches a terminal status, and every workspace-specific field was included unchanged
   in the creation request.
4. Repeat with one complete Relay workflow.
5. Verify queued, running, completed, and failed polling states render without requiring
   workflow bodies or private service details.
6. When a terminal thumbnail is present, retrieve its relative URL through
   `RELAY_API_BASE_URL` with Relay Basic authentication.
7. Simulate an ambiguous batch-creation timeout and confirm the browser does not issue a
   second POST automatically.
8. Verify logs and telemetry contain no workflow documents, payloads, parameter values,
   Basic credentials, batch IDs, artifact IDs, artifact URLs, or private service URLs.

## Out of scope

- Do not add authentication to the private automation service.
- Do not make the private automation service publicly reachable.
- Do not add batch idempotency or automatic creation retries.
- Do not change the backend request or polling schemas from the checked-in public
  `relay_backend/openapi.yaml` contract.
