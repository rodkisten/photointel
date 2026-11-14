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
