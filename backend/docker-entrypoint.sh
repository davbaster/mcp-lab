#!/bin/sh
# Container entrypoint: optionally migrate, then hand over to the command (uvicorn).
set -e

if [ "$RUN_MIGRATIONS_ON_START" = "true" ]; then
    echo "docker-entrypoint: running database migrations"
    alembic upgrade head
else
    echo "docker-entrypoint: RUN_MIGRATIONS_ON_START is not 'true', skipping database migrations"
fi

exec "$@"
