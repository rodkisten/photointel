# PhotoIntel Media Engine

Independent image and video processing, inside the existing PhotoIntel monorepo.

## Current implementation

- Imagor image service for WebP, AVIF, JPEG, PNG and transformations.
- TypeScript/Node.js video job using FFmpeg (H.264/AAC, portrait 9:16, optional text watermark, loudness normalization).
- R2 S3-compatible input/output for the video job.
- Separate Cloud Build configuration at `services/media/cloudbuild.yaml`, which **builds images only**.
- Local Docker Compose for Imagor and optional R2-backed video jobs.

## Local checks

```sh
cd services/media/video
npm install
npm run build
npm test
cd ..
docker compose up -d imagor
```

The Imagor development port binds only to 127.0.0.1. `IMAGOR_UNSAFE`
is strictly for local development and must never be deployed publicly.

Video job requires `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `MEDIA_INPUT_KEY`, `MEDIA_OUTPUT_KEY`.
Optional: `MEDIA_WATERMARK`. Keep credentials in Secret Manager.

## Production gates still required

1. Signed Cloudflare Worker gateway with authenticated object access and SSRF protection.
2. Imagor private R2 loader and result storage with strict image size limits.
3. ImagorVideo thumbnail extraction integration.
4. Explicit Cloud Run Service/Job configuration and guarded deploy/rollback scripts.
5. Verified dependencies, pinned container digests, real image/video integration tests.
6. Approval for any infrastructure provisioning or charge-incurring deploy.

No production resources, billing, triggers or existing API deploy paths are changed.
