# syntax=docker/dockerfile:1.29
# Build the real upstream server because vendor registries can withdraw releases.
FROM --platform=$BUILDPLATFORM golang:1.24-bookworm AS build
ARG TARGETOS=linux
ARG TARGETARCH
ARG MINIO_REVISION=07c3a429bfed433e49018cb0f78a52145d4bedeb
WORKDIR /source
RUN --mount=type=secret,id=build_ca,required=false \
    set -eu; \
    if [ -f /run/secrets/build_ca ]; then \
      export GIT_SSL_CAINFO=/run/secrets/build_ca SSL_CERT_FILE=/run/secrets/build_ca; \
    fi; \
    git init .; \
    git remote add origin https://github.com/minio/minio.git; \
    git fetch --depth=1 origin "$MINIO_REVISION"; \
    git checkout --detach FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$MINIO_REVISION"
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=secret,id=build_ca,required=false \
    set -eu; \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" GOMAXPROCS=2 \
      go build -p 2 -trimpath \
      -ldflags="-s -w -X github.com/minio/minio/cmd.Version=2025-09-07T16:13:09Z -X github.com/minio/minio/cmd.CommitID=$MINIO_REVISION -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-09-07T16-13-09Z" \
      -o /out/minio .

FROM alpine:3.24
ARG MINIO_REVISION=07c3a429bfed433e49018cb0f78a52145d4bedeb
LABEL org.opencontainers.image.title="Photo Intelligence local MinIO build" \
    org.opencontainers.image.source="https://github.com/minio/minio" \
    org.opencontainers.image.revision="$MINIO_REVISION" \
    org.opencontainers.image.licenses="AGPL-3.0-or-later"
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /source/LICENSE /licenses/minio-LICENSE
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
RUN addgroup -g 10001 photointel && adduser -D -H -u 10001 -G photointel -h /tmp photointel \
    && mkdir /data && chown 10001:10001 /data
ENV HOME=/tmp
USER 10001:10001
EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
