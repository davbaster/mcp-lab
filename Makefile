# The single entry point to install, check, lint, typecheck, and test every part.
# CI calls these same targets. Run `make` from the repo root.
#
# Rules for recipes (they must work with GNU Make 3.81 and with sh or cmd.exe):
# one command per line, or `cd <dir> && <command>`; no pipes, `;`, `||`, shell
# functions, VAR=value prefixes, single quotes, or Unix-only tools. A new part
# (oncall-mcp) adds its targets here, to the aggregates, and to
# the help list.

# A host port for the disposable test database. Override: make test-db-up TEST_DB_PORT=5434
TEST_DB_PORT ?= 5433

.PHONY: help \
	install install-backend install-frontend install-content-build \
	lint lint-backend lint-frontend lint-content-build \
	typecheck typecheck-frontend typecheck-content-build \
	test test-backend test-frontend test-content-build \
	check check-openapi check-api-client check-migrations \
	migrate-backend test-db-up test-db-down

HELP_TARGETS = help \
	install install-backend install-frontend install-content-build \
	lint lint-backend lint-frontend lint-content-build \
	typecheck typecheck-frontend typecheck-content-build \
	test test-backend test-frontend test-content-build \
	check check-openapi check-api-client check-migrations \
	migrate-backend test-db-up test-db-down

HELP.help = Show this list (the default target)
HELP.install = Install every part (install-backend, install-frontend, install-content-build)
HELP.install-backend = Install backend dependencies from the lock file (uv sync --locked)
HELP.install-frontend = Install frontend dependencies from the lock file (npm ci)
HELP.install-content-build = Install content-build dependencies from the lock file (npm ci)
HELP.lint = Lint every part (lint-backend, lint-frontend, lint-content-build)
HELP.lint-backend = Lint the backend (ruff)
HELP.lint-frontend = Lint the frontend (ESLint)
HELP.lint-content-build = Lint content-build (ESLint)
HELP.typecheck = Typecheck every part that has a typecheck (typecheck-frontend, typecheck-content-build)
HELP.typecheck-frontend = Typecheck the frontend (tsc --noEmit)
HELP.typecheck-content-build = Typecheck content-build (tsc --noEmit)
HELP.test = Run every test suite (test-backend, test-frontend, test-content-build)
HELP.test-backend = Run the backend tests (needs DATABASE_URL, see README Test database)
HELP.test-frontend = Run the frontend tests
HELP.test-content-build = Run the content-build tests
HELP.check = Check generated files are up to date, no database needed (check-openapi, check-api-client)
HELP.check-openapi = Check openapi.yaml matches the backend
HELP.check-api-client = Check the generated frontend API client matches openapi.yaml
HELP.check-migrations = Check the models and the migrations agree (needs DATABASE_URL, not in any aggregate)
HELP.migrate-backend = Apply all database migrations (needs DATABASE_URL, not in any aggregate)
HELP.test-db-up = Start a disposable test Postgres in Docker on TEST_DB_PORT (default 5433) and print its DATABASE_URL
HELP.test-db-down = Stop the disposable test Postgres

help:
	$(info Usage: make <target>   (run from the repo root, a variable goes after the target: make test-backend DATABASE_URL=<url>))
	$(info )
	$(foreach target,$(HELP_TARGETS),$(info $(target): $(HELP.$(target))))
	@echo Test database: see the Test database section of README.md.

install: install-backend install-frontend install-content-build
lint: lint-backend lint-frontend lint-content-build
typecheck: typecheck-frontend typecheck-content-build
test: test-backend test-frontend test-content-build
check: check-openapi check-api-client

install-backend:
	cd backend && uv sync --locked

lint-backend:
	cd backend && uv run ruff check .

test-backend:
	cd backend && uv run pytest

migrate-backend:
	cd backend && uv run alembic upgrade head

install-frontend:
	cd frontend && npm ci

lint-frontend:
	cd frontend && npm run lint

typecheck-frontend:
	cd frontend && npm run typecheck

test-frontend:
	cd frontend && npm test

install-content-build:
	cd content-build && npm ci

lint-content-build:
	cd content-build && npm run lint

typecheck-content-build:
	cd content-build && npm run typecheck

test-content-build:
	cd content-build && npm test

check-openapi:
	cd backend && uv run python scripts/export_openapi.py --check

check-migrations:
	cd backend && uv run alembic check

check-api-client:
	cd frontend && npm run check:api

test-db-up:
	docker run --rm -d --name mcp-lab-test-db -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:$(TEST_DB_PORT):5432 postgres:16
	@echo DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:$(TEST_DB_PORT)/mcp_lab_test
	@echo Postgres needs a few seconds before it accepts connections.

test-db-down:
	docker stop mcp-lab-test-db
