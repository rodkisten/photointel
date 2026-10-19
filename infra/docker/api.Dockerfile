# Build from the REPOSITORY ROOT, never from infra/docker/:
#   docker build -f infra/docker/api.Dockerfile -t photointel-api .
# The official Cloud Build Docker builder does not enable BuildKit by default.
# Keep this file compatible with classic Docker builds (no RUN --mount).

FROM ghcr.io/astral-sh/uv:0.12.23 AS uv

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

FROM python:3.12-slim-bookworm AS runtime
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends libglib2.0-0 libgomp1; \
    rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 photointel && \
    useradd --uid 10001 --gid 10001 --no-create-home photointel
WORKDIR /app
COPY --from=build --chown=10001:10001 /app /app
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_ENV=production \
    AUTH_MODE=cloudflare
USER 10001:10001
EXPOSE 8000
STOPSIGNAL SIGTERM
CMD ["sh", "infra/docker/start-api.sh"]
