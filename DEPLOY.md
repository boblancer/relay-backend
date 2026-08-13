# Deploy to Railway

Two services: public **relay-api** (Python FastAPI) and private **relay-automation**
(Node.js Fastify). Batch state is process-local, so `relay-automation` must run exactly
one replica.

## Prerequisites

- Railway account with a project created
- GitHub repository connected to Railway
- One complete synthetic Local or Relay workflow document for gateway verification

## Steps

### 1. Add Railway Postgres and storage

Add PostgreSQL and a private Storage Bucket. Expose the database URL and the bucket's
`BUCKET`, `ENDPOINT`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, and `REGION` variables only
to `relay-api`.

### 2. Deploy private relay-automation

Create a service from this repository with:

- **Dockerfile path:** `Dockerfile.automation`
- **Public networking:** disabled
- **Replica count:** exactly `1`
- **Private port:** `8080`
- **Health-check path:** `/health/ready`
- **Health-check port:** `8080`
- **Environment variables:**

| Variable | Value |
| --- | --- |
| `BROWSERBASE_API_KEY` | Browserbase API key |
| `PORT` | `8080` |
| `AUTOMATION_HOST` | `0.0.0.0` |
| `AUTOMATION_SCREENSHOTS` | `false` |

Do not add authentication to this service and do not expose a public domain. Railway's
private health check must report `/health/ready` as ready before configuring the API.

### 3. Deploy public relay-api

Create a second service from this repository with:

- **Dockerfile path:** `Dockerfile.api`
- **Public networking:** enabled on port `8000`
- **Environment variables:**

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `BASIC_AUTH_USERNAME` | chosen Relay username |
| `BASIC_AUTH_PASSWORD` | strong Relay password |
| `BUCKET` | Railway bucket reference |
| `ENDPOINT` | Railway bucket reference |
| `ACCESS_KEY_ID` | Railway bucket reference |
| `SECRET_ACCESS_KEY` | Railway bucket reference |
| `REGION` | Railway bucket reference |
| `AUTOMATION_SERVICE_URL` | `http://${{relay-automation.RAILWAY_PRIVATE_DOMAIN}}:8080` |
| `PORT` | `8000` |

Verify `https://<relay-api>.up.railway.app/docs` loads the Scalar reference. Neither
Railway nor another proxy may retry automation POST requests.

### 4. Verify the authenticated batch gateway

Use a synthetic complete workflow that is safe to execute. Replace the URL and credentials
without writing them into the repository:

```bash
jq -n --slurpfile workflow synthetic-workflow.json \
  '{runs: [{workflow: $workflow[0]}]}' > /tmp/relay-synthetic-batch.json

curl \
  --user "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" \
  --header "Accept: application/json" \
  --header "Content-Type: application/json" \
  --data-binary @/tmp/relay-synthetic-batch.json \
  https://<relay-api>.up.railway.app/v1/batches

# Copy batchId from the 202 response.
BATCH_ID="..."
curl \
  --user "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" \
  --header "Accept: application/json" \
  "https://<relay-api>.up.railway.app/v1/batches/$BATCH_ID"
```

Repeat with the other supported document source (Local or Relay). Acceptance requires
both documents to reach a terminal polling state through `relay-api` without any public
access to `relay-automation`.

## Browser follow-up

Follow [`tasks/browser-remote-batch-gateway-handoff.md`](tasks/browser-remote-batch-gateway-handoff.md).
Remove `AUTOMATION_SERVICE_TOKEN`; the browser sends Relay HTTP Basic credentials only
to the public `RELAY_API_BASE_URL`, while the private automation service remains
unauthenticated. Preserve non-retrying batch creation.

## Local Docker build test

```bash
docker build -f Dockerfile.api -t relay-api .
docker build -f Dockerfile.automation -t relay-automation .
```
