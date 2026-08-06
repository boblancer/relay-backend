# ADR-009: Store terminal screenshots locally behind temporary URLs

## Status

Accepted

## Date

2026-08-05

## Context

Direct and batch callers need a small visual indication of the page state where a
Browserbase run completed, failed, was cancelled, or timed out. The image can contain
credentials, personal data, parameter values, and other page content, so it cannot be
treated like the existing privacy-safe numeric run projection. Inline image data would
also enlarge every direct terminal line and every repeated batch poll.

`@relay/automation-core` receives a caller-owned Playwright `Page` and deliberately does
not own browser lifecycle or persistence. The Browserbase worker still has that page
immediately after the core runner returns and before it closes the browser and releases
the provider session.

## Decision

The Browserbase worker accepts an optional terminal-screenshot callback. When supplied,
it captures the visible viewport after the core runner returns and before cleanup. The
capture and callback receive a two-second best-effort budget, and any failure preserves
the original automation outcome and cleanup behavior. The service supplies the callback
for direct and batch runs, but not for the local Inngest adapter.

The service converts captures to bounded WebP thumbnails and writes them atomically to
the project-local `.relay/artifacts` directory by default. Files use opaque UUID names,
remain on disk until an operator removes them, and are never loaded into process state
at startup.

An in-memory allowlist grants each newly written artifact a one-hour relative URL under
`GET /v1/artifacts/{artifactId}`. Expiry or process restart makes the URL return `404`
without deleting the file. Direct terminal outcomes and terminal batch run snapshots
may include the URL and fixed image metadata. Image bytes, local paths, artifact IDs,
and artifact URLs never enter logs. Screenshot serving is enabled by default, can be
disabled explicitly, and requires a loopback listener.

This decision supersedes only ADR 0007's rule that batch polling never returns any URL.
Its safe scalar progress projection, process-local batch state, capacity, shutdown,
privacy, and no-retry decisions remain accepted. ADR 0008's unauthenticated loopback
boundary remains accepted.

## Consequences

- Callers can render a small terminal preview without retransmitting image bytes during
  polling.
- Thumbnail URLs are sensitive capabilities even though they contain only opaque IDs.
- Run and URL metadata remains process-local, while image files deliberately survive
  URL expiry and restart for manual local inspection.
- The artifact directory grows without automatic bounds and requires operator cleanup.
- Disabling screenshots is required before configuring a non-loopback listener, though
  the unauthenticated POC must not be exposed publicly in either mode.
- `sharp` becomes a service dependency for bounded WebP conversion; automation-core
  remains unchanged.

## Alternatives considered

### Put base64 images in run and batch JSON

Rejected because base64 expands the payload and batch polling would retransmit every
image repeatedly.

### Capture screenshots inside automation-core

Rejected because capture policy, image persistence, and browser cleanup belong to the
provider worker and transport service rather than the provider-neutral action runner.

### Serve every artifact file found on disk

Rejected because restart would unintentionally restore access to historical sensitive
images and turn the filesystem into durable API state.

### Automatically delete expired files

Rejected for this local POC because the operator wants screenshots to remain available
for manual inspection after their API URLs expire.
