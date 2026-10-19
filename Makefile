SHELL := /bin/bash
.DEFAULT_GOAL := help

# Photo Intelligence Cloud (original project settings)
UV := UV_CACHE_DIR=/tmp/photointel-uv-cache uv
NPM := npm --cache /tmp/photointel-npm-cache --prefix apps/web
COMPOSE := bash infra/scripts/compose.sh
ASSETS ?= 100
REPORT ?= reports/benchmark-$(ASSETS).json
GCP_CONFIG ?= infra/gcp/config.local.json
GCP_ARGS ?=
BACKUP_DIRECTORY ?= backups/application
BACKUP_KEY_FILE ?=
POSTGRES_CONTAINER ?= photointel-v11-postgres
CAPACITY_ASSETS ?= 1000
CAPACITY_REPORT ?= reports/capacity-$(CAPACITY_ASSETS).json
E2E_ARGS ?=

# GitHub Actions interactive SSH session
SESSION_MINUTES ?= 60

.PHONY: help setup dev stop migrate seed lint typecheck test test-integration test-e2e build doctor ingest-test gpu-test backup restore-test benchmark export cleanup info check finish keepalive

help:
	@printf '%s\n' \
	  'Photo Intelligence Cloud — available commands:' \
	  '  make setup              Prepare .env, install uv and npm (creates missing lockfiles)' \
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
	@if [[ ! -f pyproject.toml ]]; then \
	  echo '[setup] ERROR: pyproject.toml not found in repository root' >&2; \
	  exit 1; \
	elif [[ -f uv.lock ]]; then \
	  echo '[setup] uv.lock found; installing frozen dependencies'; \
	  $(UV) sync --frozen --group ingest; \
	else \
	  echo '[setup] uv.lock absent; resolving dependencies and generating uv.lock'; \
	  $(UV) sync --group ingest; \
	fi
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
	$(COMPOSE) exec -T api python -m photointel.cli seed --synthetic-assets $(ASSETS)

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
	$(UV) run python infra/scripts/test-e2e-local.py $(E2E_ARGS)

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
	@echo 'Este comando legado salva somente PostgreSQL. Use backup-application para banco e objetos.'
	bash infra/scripts/backup.sh

restore-test:
	bash infra/scripts/restore-test.sh

.PHONY: backup-application verify-backup restore-application-test capacity-benchmark benchmark-capacity release-manifest
backup-application:
	@test -n "$(BACKUP_KEY_FILE)" || { echo 'Defina BACKUP_KEY_FILE (chave privada de 32 bytes)' >&2; exit 2; }
	$(UV) run python -m photointel.services.backup create --directory "$(BACKUP_DIRECTORY)" --key-file "$(BACKUP_KEY_FILE)"

verify-backup:
	@test -n "$(BACKUP_KEY_FILE)" || { echo 'Defina BACKUP_KEY_FILE' >&2; exit 2; }
	$(UV) run python -m photointel.services.backup verify --directory "$(BACKUP_DIRECTORY)" --key-file "$(BACKUP_KEY_FILE)"

restore-application-test:
	$(UV) run python infra/scripts/backup-restore-ci.py --postgres-container "$(POSTGRES_CONTAINER)"

capacity-benchmark:
	$(UV) run python infra/scripts/capacity-benchmark.py --assets "$(CAPACITY_ASSETS)" --confirm-disposable SYNTHETIC_ONLY --output "$(CAPACITY_REPORT)"

benchmark-capacity: ASSETS=1000
benchmark-capacity:
	$(UV) run python infra/scripts/capacity-benchmark.py --assets "$(ASSETS)" --confirm-disposable SYNTHETIC_ONLY --output "$(REPORT)"

release-manifest:
	python3 infra/scripts/release-manifest.py --output reports/release-manifest.json

# Read-only plans are the default. Mutation needs all explicit authorization flags.
.PHONY: gcp-doctor gcp-bootstrap gcp-build gcp-deploy gcp-migrate gcp-jobs-deploy gcp-scheduler gcp-smoke gcp-rollback gcp-cleanup gcp-render
gcp-doctor gcp-bootstrap gcp-build gcp-deploy gcp-migrate gcp-jobs-deploy gcp-scheduler gcp-smoke gcp-rollback gcp-cleanup gcp-render:
	python3 infra/gcp/manage.py $(@:gcp-%=%) --config "$(GCP_CONFIG)" $(GCP_ARGS)

benchmark: ASSETS=10000
benchmark:
	$(UV) run python -m photointel.cli benchmark --assets $(ASSETS) --output $(REPORT)

export:
	$(UV) run python -m photointel.cli export --output exports

cleanup:
	python3 infra/scripts/cleanup-temp.py --directory var/processing --hours 24 --apply


# Administration runs inside the container using the same protected session volume.
.PHONY: icloud-auth icloud-verify icloud-libraries icloud-test icloud-status
icloud-auth:
	$(COMPOSE) run --rm ingestion python -m photointel.services.icloud_admin authenticate

icloud-verify:
	$(COMPOSE) run --rm -T ingestion python -m photointel.services.icloud_admin verify

icloud-libraries:
	$(COMPOSE) run --rm -T ingestion python -m photointel.services.icloud_admin libraries

icloud-test:
	$(COMPOSE) run --rm -T ingestion python -m photointel.services.icloud_admin test

icloud-status:
	$(COMPOSE) run --rm -T ingestion python -m photointel.services.icloud_admin status

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
