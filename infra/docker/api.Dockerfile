# Build from the REPOSITORY ROOT, never from infra/docker/:
#   docker build -f infra/docker/api.Dockerfile -t photointel-api .
# The official Cloud Build Docker builder does not enable BuildKit by default.
# Keep this file compatible with classic Docker builds (no RUN --mount).
# Compose uses api.buildkit.Dockerfile for transient custom CA secrets.

FROM ghcr.io/astral-sh/uv:0.13.8 AS uv

FROM python:3.12-slim-bookworm AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# The monorepo's lockfile and local icloudpd package need the root context.
COPY . /app
RUN test -f pyproject.toml && \
    test -f uv.lock && \
    test -d apps/api/src/photointel && \
    test -d packages/icloudpd-source || \
    (echo >&2 'ERROR: Docker build context must be the repository root (.). Use cloudbuild.yaml.'; exit 1)
RUN uv sync --frozen --no-dev --group ingest

# Catch broken Python imports in Cloud Build instead of discovering them via
# Cloud Run startup probes. No production secrets or network services required.
# Exercise Neon's default libpq URL without connecting to any database. Catch
# incompatible SSL/channel-binding profiles during Cloud Build, not Cloud Run startup.
RUN /app/.venv/bin/python -c "from photointel.main import app; assert app.title == 'Photo Intelligence Cloud'; from photointel.config import Settings; from photointel.db_connection import database_connection_options; from sqlalchemy.ext.asyncio import create_async_engine; settings = Settings(_env_file=None, database_require_tls=True, database_url='postgresql://test:test@ep-test.neon.tech/db?sslmode=require&channel_binding=require'); url, args = database_connection_options(settings); assert url.drivername == 'postgresql+psycopg' and url.query['channel_binding'] == 'require' and url.query['sslmode'] == 'verify-full' and url.query['sslrootcert'] == 'system'; from psycopg import pq; assert pq.version() >= 170000; engine = create_async_engine(url, connect_args=args); assert engine.dialect.driver == 'psycopg'"

FROM python:3.12-slim-bookworm AS runtime
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates libglib2.0-0 libgomp1; \
    rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 photointel && \
    useradd --uid 10001 --gid 10001 --no-create-home photointel
WORKDIR /app
COPY --from=build --chown=10001:10001 /app /app
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DATABASE_TLS_CA_FILE=/etc/ssl/certs/ca-certificates.crt \
    APP_ENV=production \
    AUTH_MODE=cloudflare
USER 10001:10001
EXPOSE 8000
STOPSIGNAL SIGTERM
CMD ["sh", "infra/docker/start-api.sh"]
