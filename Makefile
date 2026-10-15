SHELL := /bin/bash
.DEFAULT_GOAL := help

# Photo Intelligence Cloud (original project settings)
UV := UV_CACHE_DIR=/tmp/photointel-uv-cache uv
NPM := npm --cache /tmp/photointel-npm-cache --prefix apps/web
COMPOSE := bash infra/scripts/compose.sh
ASSETS ?= 100
REPORT ?= reports/benchmark-$(ASSETS).json

# GitHub Actions interactive SSH session
SESSION_MINUTES ?= 60

.PHONY: help setup dev stop migrate seed lint typecheck test test-integration test-e2e build doctor ingest-test gpu-test backup restore-test benchmark export cleanup info check finish keepalive

help:
	@printf '%s\n' \
	  'Photo Intelligence Cloud — available commands:' \
	  '  make setup              Prepare .env, install uv and npm dependencies' \
	  '  make dev                Start services with Docker Compose' \
	  '  make stop               Stop services' \
	  '  make migrate            Apply Alembic migrations' \
	  '  make seed               Create synthetic assets (ASSETS=100)' \
	  '  make lint               Ruff and frontend lint' \
	  '  make typecheck          Mypy and frontend typecheck' \
	  '  make test               Unit tests (pytest + npm)' \
	  '  make test-integration   Integration tests' \
	  '  make test-e2e           Frontend end-to-end tests' \
	  '  make build              Frontend and Docker images' \
	  '  make doctor             Project diagnostics' \
	  '  make ingest-test        Ingestion test' \
	  '  make gpu-test           GPU-marked tests (requires a GPU-capable runner)' \
	  '  make backup             Run backup script' \
	  '  make restore-test       Validate restore' \
	  '  make benchmark          Benchmark (default ASSETS=10000)' \
	  '  make export             Export project data' \
	  '  make cleanup            Remove old temporary processing files' \
	  '  make check              Run lint, typecheck, and unit tests' \
	  '  make info               Display tool versions and Git state' \
	  '  make finish             End SSH session and trigger Auto Commit & Push' \
	  '  make keepalive          Wait for SSH session (used by GitHub Actions)'

setup:
	python3 infra/scripts/setup-env.py
	$(UV) sync --frozen --group ingest
	@if [[ -f apps/web/package-lock.json || -f apps/web/npm-shrinkwrap.json ]]; then \
	  $(NPM) ci; \
	elif [[ -f apps/web/package.json ]]; then \
	  echo '[setup] npm lockfile not found under apps/web; using npm install'; \
	  $(NPM) install; \
	else \
	  echo '[setup] apps/web/package.json absent; skipping npm installation'; \
	fi

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

# Optional helper targets added for the remote development workflow.
check: lint typecheck test

info:
	@printf 'Repository: %s\n' "$$(git rev-parse --show-toplevel)"
	@printf 'Branch: %s\n' "$$(git branch --show-current)"
	@printf 'Python: '; python3 --version
	@printf 'uv: '; uv --version
	@printf 'Node: '; node --version
	@printf 'npm: '; npm --version
	@printf 'Make: '; make --version | head -n 1
	@command -v tailscale >/dev/null 2>&1 && tailscale ip -4 || true

# Marker lives inside .git, so it is never staged by 'git add -A'.
# Run 'make finish' from the SSH checkout to release the waiting workflow step.
finish:
	@marker="$$(git rev-parse --git-path dev-ssh-finish)"; \
	  touch "$$marker"; \
	  echo '[ssh] Session finish requested. Auto Commit & Push will start shortly.'

keepalive:
	@case "$(SESSION_MINUTES)" in \
	  30|60|120|180) ;; \
	  *) echo 'SESSION_MINUTES must be 30, 60, 120, or 180' >&2; exit 2 ;; \
	esac
	@echo "[ssh] Session active for up to $(SESSION_MINUTES) minutes."
	@echo '[ssh] From the SSH checkout, run: make finish'
	@marker="$$(git rev-parse --git-path dev-ssh-finish)"; \
	  deadline=$$((SECONDS + $(SESSION_MINUTES) * 60)); \
	  while (( SECONDS < deadline )); do \
	    if [[ -f "$$marker" ]]; then \
	      rm -f -- "$$marker"; \
	      echo '[ssh] Finish detected. Advancing to Auto Commit & Push.'; \
	      exit 0; \
	    fi; \
	    sleep 5; \
	  done; \
	  echo '[ssh] Session time elapsed. Advancing to Auto Commit & Push.'
