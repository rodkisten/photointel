# syntax=docker/dockerfile:1.29
# Local BuildKit variant: cloud builds use api.Dockerfile.
# Keep runtime/dependency pins synchronized with that file.
FROM ghcr.io/astral-sh/uv:0.12.23 AS uv
FROM python:3.12-slim-bookworm AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY . /app
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --frozen --no-dev --group ingest

FROM python:3.12-slim-bookworm AS runtime
RUN --mount=type=secret,id=build_ca,required=false \
    set -eu; \
    if [ -f /run/secrets/build_ca ]; then \
      printf 'Acquire::https::CaInfo "/run/secrets/build_ca";\n' > /tmp/apt-proxy-ca.conf; \
      export APT_CONFIG=/tmp/apt-proxy-ca.conf; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates libglib2.0-0 libgomp1; \
    rm -rf /var/lib/apt/lists/* /tmp/apt-proxy-ca.conf
RUN groupadd --gid 10001 photointel && useradd --uid 10001 --gid 10001 --no-create-home photointel
WORKDIR /app
COPY --from=build --chown=10001:10001 /app /app
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    DATABASE_TLS_CA_FILE=/etc/ssl/certs/ca-certificates.crt \
    APP_ENV=production AUTH_MODE=cloudflare
USER 10001:10001
EXPOSE 8000
STOPSIGNAL SIGTERM
CMD ["sh", "infra/docker/start-api.sh"]
