# ADR-002: Protect the POC with shared HTTP Basic authentication

## Status

Accepted

## Date

2026-07-30

## Context

The source workflow contract did not define authentication, but stored documents may
contain credentials, payment values, tokens, and session identifiers. The POC needs a
minimal access boundary without introducing users, tenants, sessions, or token issuance.

## Decision

Require one shared HTTP Basic username and password for all workflow routes. Read both
values from environment variables, compare them in constant time, and return one generic
`401 unauthorized` response for missing or invalid credentials.

Document the security scheme and `401` response in the repository's OpenAPI contract.
Do not log authorization headers or submitted credentials.

## Alternatives considered

### Anonymous access

Rejected because list and get operations would expose every stored workflow to any
caller able to reach the service.

### User accounts and tenant authorization

Rejected because identity, profiles, and collaboration are explicitly outside the
version-one persistence scope.

### Gateway-only authentication

Viable for deployment, but it would make the locally run POC depend on another process
and leave the application's actual wire requirement undocumented.

## Consequences

- All callers share access to one workflow collection.
- Password rotation requires changing environment configuration and restarting the app.
- HTTP Basic must be used behind TLS if this POC is exposed beyond localhost.
- A production multi-user service will require a new authentication and ownership model.

