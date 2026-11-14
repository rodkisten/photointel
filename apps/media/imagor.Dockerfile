# The upstream image is deliberately pinned at release time using an immutable digest.
# Supply IMAGOR_BASE_IMAGE=shumc/imagor@sha256:<verified digest> from a reviewed build.
ARG IMAGOR_BASE_IMAGE
FROM ${IMAGOR_BASE_IMAGE}

# Conservative single-user / scale-to-zero baseline. Override after measured load tests.
# Never bake IMAGOR_SECRET, R2 credentials, or issuer tokens into the image.
ENV VIPS_CONCURRENCY=1 \
    IMAGOR_PROCESS_CONCURRENCY=2 \
    VIPS_MAX_WIDTH=5000 \
    VIPS_MAX_HEIGHT=5000 \
    VIPS_MAX_RESOLUTION=16000000 \
    VIPS_MAX_ANIMATION_FRAMES=1 \
    VIPS_MAX_FILTER_OPS=12 \
    VIPS_STRIP_METADATA=1 \
    VIPS_AVIF_SPEED=8 \
    VIPS_MAX_CACHE_MEM=0 \
    VIPS_MAX_CACHE_SIZE=0 \
    VIPS_MAX_CACHE_FILES=0 \
    IMAGOR_REQUEST_TIMEOUT=30s \
    IMAGOR_LOAD_TIMEOUT=10s \
    HTTP_LOADER_HTTPS_ONLY=1 \
    IMAGOR_SIGNER_TYPE=sha256

# Runtime requirements: signed requests, private authenticated source loader,
# restricted Cloud Run ingress, tenant authorization at the independent Media API.
