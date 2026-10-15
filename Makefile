SHELL := /bin/bash
.DEFAULT_GOAL := help
UV := UV_CACHE_DIR=/tmp/photointel-uv-cache uv
NPM := npm --cache /tmp/photointel-npm-cache --prefix apps/web
COMPOSE := bash infra/scripts/compose.sh
ASSETS ?= 100
REPORT ?= reports/benchmark-$(ASSETS).json

.PHONY: help setup dev stop migrate seed lint typecheck test test-integration test-e2e build doctor ingest-test gpu-test backup restore-test benchmark export cleanup
help:
	@printf '%s\n' 'setup dev stop migrate seed lint typecheck test test-integration test-e2e build doctor ingest-test gpu-test backup restore-test benchmark export cleanup'
setup:
	python3 infra/scripts/setup-env.py
	$(UV) sync --frozen --group ingest
	$(NPM) ci
dev:
	$(COMPOSE) up --build -d
stop:
	$(COMPOSE) stop
migrate:
	$(UV) run alembic -c infra/migrations/alembic.ini upgrade head
seed:
	$(UV) run python -m photointel.cli seed --synthetic-assets $(ASSETS)
lint:
	$(UV) run ruff check .
	$(NPM) run lint
typecheck:
	$(UV) run mypy apps/api/src gpu bridges
	$(NPM) run typecheck
test:
	$(UV) run pytest -m 'not integration and not gpu and not e2e'
	$(NPM) test
test-integration:
	$(UV) run pytest -m integration
test-e2e:
	$(NPM) run test:e2e
build:
	$(NPM) run build
	$(COMPOSE) build api frontend
doctor:
	$(UV) run python -m photointel.cli doctor --json
ingest-test:
	$(UV) run python -m photointel.cli ingest-test
gpu-test:
	$(UV) run pytest -m gpu
backup:
	bash infra/scripts/backup.sh
restore-test:
	bash infra/scripts/restore-test.sh
benchmark: ASSETS=10000
benchmark:
	$(UV) run python -m photointel.cli benchmark --assets $(ASSETS) --output $(REPORT)
export:
	$(UV) run python -m photointel.cli export --output exports
cleanup:
	python3 infra/scripts/cleanup-temp.py --directory var/processing --hours 24 --apply
