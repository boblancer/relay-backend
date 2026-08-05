# ADR-008: Use an unauthenticated local execution service for the POC

## Status

Accepted

## Date

2026-08-04

## Context

The Browserbase execution service is a local proof of concept used by a frontend/BFF and
the opt-in Inngest development adapter. Its bearer token added setup and integration
friction without providing user identity, workflow ownership, tenancy, or authorization.
Those production security decisions remain outside the current POC.

Removing the token increases the consequence of accidentally exposing the listener.
Workflow execution can create paid Browserbase sessions and browser actions can have
external side effects. Privacy-safe responses and disabled request/header logging do not
make a publicly reachable execution endpoint safe.

## Decision

The execution service's Relay HTTP routes are unauthenticated:

- `POST /v1/run`;
- `POST /v1/batches`; and
- `GET /v1/batches/{batchId}`.

`AUTOMATION_SERVICE_TOKEN` and the corresponding runtime configuration are removed.
Callers do not send an `Authorization` header, and an arbitrary header has no effect on
request handling. JSON/NDJSON negotiation, validation, request-size limits, shared
capacity, shutdown behavior, and privacy projections remain unchanged.

`AUTOMATION_HOST` defaults to `127.0.0.1`. An operator may explicitly override it, but
the unauthenticated service must not be exposed publicly. The Inngest SDK adapter and
the persistence API's separate HTTP Basic authentication are unchanged.

This decision supersedes only the bearer-authentication portions of ADR 0005 and ADR
0007. Their worker lifecycle, privacy, capacity, no-retry, and process-local batch
decisions remain accepted.

## Consequences

- Local frontend and BFF integrations need no shared token or secret distribution.
- The service starts with only the Browserbase credential required for real execution.
- Any process that can reach the listener can submit side-effecting, potentially paid
  work and poll known batch IDs.
- Loopback is a safety boundary for the POC, not an authentication mechanism.
- Restoring authentication requires a reviewed wire contract and a new superseding ADR.

## Alternatives considered

### Keep the shared bearer token

Rejected for this POC because it complicates local callers without solving user-level
authorization or multi-tenant isolation.

### Make authentication optional through a feature flag

Rejected because two security modes would enlarge the test and configuration surface
and make the local deployment posture less obvious.

### Rely on CORS

Rejected because CORS is a browser policy and does not authenticate non-browser callers
or protect a reachable server endpoint.
