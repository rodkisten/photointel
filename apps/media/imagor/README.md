# Imagor runtime profile

The `apps/media/imagor.Dockerfile` configures a conservative, bounded profile for a private Cloud Run service that can scale to zero. It is **not deployed** by this change. The existing `services/media` pipeline remains authoritative until migration tests pass.

## Build safety

Build with `IMAGOR_BASE_IMAGE=shumc/imagor@sha256:<verified-release-digest>`. The Cloud Build substitution `_IMAGOR_BASE_IMAGE` is deliberately a placeholder and must be supplied after reviewing the upstream release and its architecture. Never deploy `latest` to production. The `apps/media/cloudbuild.yaml` file is build-only and does not provision resources.

## Runtime tuning

| Variable | Initial value | Why |
| --- | --- | --- |
| `VIPS_CONCURRENCY` | `1` | One libvips thread per operation; avoid CPU oversubscription |
| `IMAGOR_PROCESS_CONCURRENCY` | `2` | Bound concurrent image processing requests |
| `VIPS_MAX_RESOLUTION` | `16000000` | Reject oversized decoded images |
| `VIPS_MAX_WIDTH` / `VIPS_MAX_HEIGHT` | `5000` | Bound input dimensions |
| `VIPS_MAX_ANIMATION_FRAMES` | `1` | Avoid expensive animated image decoding |
| `VIPS_MAX_FILTER_OPS` | `12` | Limit processing complexity |
| `VIPS_STRIP_METADATA` | `1` | Strip output metadata and reduce file size |
| `VIPS_AVIF_SPEED` | `8` | Prefer fast AVIF encoding over maximum compression |
| `VIPS_MAX_CACHE_*` | `0` | Avoid low-value per-process libvips operation cache |
| `IMAGOR_REQUEST_TIMEOUT` | `30s` | Bound overall processing |
| `IMAGOR_LOAD_TIMEOUT` | `10s` | Bound loader latency |

### Production gates

1. Supply `IMAGOR_SECRET` from Secret Manager at runtime, never Dockerfile or Terraform state. Verify SHA-256 signed URLs and reject unsafe URLs.
2. Do not expose arbitrary HTTP sources. Set an explicit private R2-compatible loader or trusted signed source integration; restrict egress and HTTP loader sources. HTTPS-only is **not** sufficient authorization.
3. Keep Cloud Run ingress private and require service-to-service authorization. Multi-tenant access checks belong to the independent Media API.
4. Benchmark 1 vs 2 processing slots with actual image fixtures, measure p50/p95 latency, peak RSS, output quality, cold starts and cost. Tune CPU/memory together with request concurrency and scale-to-zero.
5. Validate the chosen upstream image's available codecs and verify whether ImagorVideo requires a separate compatible image or custom build. The base `shumc/imagor` image is **not assumed** to include ImagorVideo.
6. Validate R2 read/write behavior, cache correctness, error handling and tenant isolation before removing the Sharp job.

References: https://docs.imagor.net/configuration/ , https://docs.imagor.net/security/ , https://docs.imagor.net/vips-performance/ .

## Private R2 source gateway (staged, not deployed)

The staged Cloudflare gateway now exposes `GET /v1/source/originals/<tenant>/<key>` **only when both** `MEDIA_SOURCE_TOKEN` (at least 32 characters) and `MEDIA_SOURCE_PREFIX` (an explicit `originals/.../` scope) are configured. It requires `Authorization: Bearer <MEDIA_SOURCE_TOKEN>`, rejects keys outside the configured prefix and returns `Cache-Control: private, no-store`. Keep this token separate from `MEDIA_ISSUER_TOKEN` and `MEDIA_SIGNING_KEY`. Never place it in image URLs, client-side JavaScript, or logs.

**Important integration gate:** This endpoint is a private R2 origin, not a completed Imagor loader integration. Confirm the selected Imagor release can attach the required Authorization header when fetching from the origin, or implement an internal authenticated loader adapter. Do not enable a public arbitrary-URL HTTP loader as a workaround. Limit access at Cloudflare Access/network policy in addition to the bearer token; this route is not suitable for unauthenticated public use. The current single-prefix configuration is a per-instance boundary, not dynamic multi-tenant authorization.

Production remains unchanged until loader compatibility, tenancy, rate limits, image-size limits, and the complete transformation path are verified.

## Signed HTTP-loader source URL (staged)

A trusted backend can now call `POST /v1/source/sign` with the dedicated `MEDIA_SOURCE_TOKEN` bearer and JSON `{"key":"originals/tenant-a/example.jpg"}`. The gateway returns a URL scoped to that object and expiring within **60 seconds**. Imagor can fetch the resulting HTTPS URL through its standard HTTP loader without needing a custom Authorization header. The original R2 bucket stays private.

The gateway validates expiry, signature, path and configured source prefix on every read. This is an **origin-access primitive**, not a finished Imagor deployment or full tenant authorization system. Signed URLs are bearer capabilities: avoid access-log/query-string leakage, use HTTPS only, enforce an Imagor outbound host allowlist and source-size limits, and never permit clients to supply arbitrary loader URLs. The Media API must authenticate the caller and authorize the tenant **before** minting a URL. Production integration and load testing remain pending.
