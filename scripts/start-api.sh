#!/usr/bin/env bash
set -euo pipefail

echo "Running database migrations..."
alembic upgrade head

echo "Starting uvicorn..."
exec uvicorn relay_backend.main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --no-access-log
