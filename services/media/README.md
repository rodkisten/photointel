# PhotoIntel Media Engine (initial scaffold)

The media engine is additive: it does not replace existing PhotoIntel ingestion,
API, Workers or deployment resources.

## Components

- **Imagor**: on-demand images (WebP, AVIF, resize, crop, image watermark).
- **FFmpeg**: asynchronous full-video exports (H.264/AAC, portrait, optional
  attribution watermark and loudness normalization).
- **ImagorVideo**: planned separate deployment for video-frame thumbnails.
- **Cloudflare R2**: originals and derived objects; production integration pending.
- **Cloudflare Worker**: planned authenticated, signed gateway and CDN caching.

## Local

```sh
cd services/media
docker compose up -d imagor
# video processing with a local file:
mkdir -p work
docker compose run --rm video --input /work/input.mp4 --output /work/story.mp4
```

The Imagor compose configuration deliberately enables `IMAGOR_UNSAFE` **only**
on loopback for local development. Do not publish this configuration to Cloud
Run. Production must use signed URLs, an origin allowlist, private credentials
from Secret Manager, R2 integration and request limits.

## Deployment integration (not enabled)

Cloud Build can build independent Imagor and FFmpeg images into the existing
Artifact Registry, then publish an Imagor Cloud Run Service and FFmpeg Cloud Run
Job. Do not modify the existing guarded `infra/gcp/manage.py` deployment path
or add an automatic production trigger before the security and cost review.

This scaffold does not provision infrastructure, change billing, or deploy.
