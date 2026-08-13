# Deploy to Railway

Two services: **relay-api** (Python FastAPI) and **relay-automation** (Node.js Fastify).

## Prerequisites

- Railway account with a project created
- GitHub repo connected to Railway

## Steps

### 1. Add Railway Postgres

Add the **PostgreSQL** plugin from the Railway dashboard. Copy the `DATABASE_URL` from the plugin's variables.

### 2. Deploy relay-api

Create a new service in Railway:

- **Source:** this GitHub repo
- **Dockerfile path:** `Dockerfile.api`
- **Public networking:** enable, port `8000`
- **Environment variables:**

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway reference) |
| `BASIC_AUTH_USERNAME` | choose a username |
| `BASIC_AUTH_PASSWORD` | choose a strong password |
| `AUTOMATION_SERVICE_URL` | `${{relay-automation.RAILWAY_PRIVATE_DOMAIN}}:8080` with the `http://` scheme |
| `PORT` | `8000` |

Verify: `https://<relay-api>.up.railway.app/docs` loads the Scalar API reference.

### 3. Deploy relay-automation

Create a second service in Railway:

- **Source:** this GitHub repo
- **Dockerfile path:** `Dockerfile.automation`
- **Public networking:** disabled (private service)
- **Environment variables:**

| Variable | Value |
|----------|-------|
| `BROWSERBASE_API_KEY` | your Browserbase API key |
| `PORT` | `8080` |

`AUTOMATION_HOST` and `AUTOMATION_SCREENSHOTS` are set in the Dockerfile defaults.

Verify via Railway logs that the service starts and `/health/live` responds.

Redeploy **relay-api** after the automation service's private domain is available. Verify
an authenticated `POST /v1/run-by-id` with a completed workflow UUID; do not configure
automatic proxy retries because browser actions can have external side effects.

## Local Docker build test

```bash
docker build -f Dockerfile.api -t relay-api .
docker build -f Dockerfile.automation -t relay-automation .
```
