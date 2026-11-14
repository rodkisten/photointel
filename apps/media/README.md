# Media Engine (independent application)

The Media Engine is a standalone multi-client application hosted in the PhotoIntel monorepo. It reuses the existing GCP project and shared infrastructure, **not** PhotoIntel API authentication, database models, or application lifecycle.

## Migration status

This directory is the destination for the staged migration from `services/media/`. The existing image and video Cloud Run Jobs, Terraform state, and release workflows remain authoritative until their replacements have been verified. **Do not delete or rename Terraform resources merely to move source files.**

## Target components

- `api/`: independent authenticated multi-tenant API, client credentials, authorized storage references, jobs, and signed URL issuance.
- `gateway/`: Cloudflare R2 delivery Worker with signed URLs, HEAD, Range/206, and private cache semantics.
- `imagor/`: private Imagor and compatible video thumbnail extraction, replacing the Sharp image job only after parity tests.
- `video/`: FFmpeg processing jobs for transcoding and audio normalization.
- `sdk/`: versioned TypeScript client for PhotoIntel, Jardim, and other applications.
- `dashboard/`: mobile-first administration of clients, jobs, quotas, logs, and costs.

## Release contract

A media-specific CI validates only media changes. A media-specific manual release offers `plan`, `build`, `deploy`, and `build-and-deploy` and component choices `all`, `api`, `imagor`, `video`, `gateway`, and `dashboard`. The existing top-level release's `media` target delegates to this workflow. Deploys preserve existing production images when no new build is requested.

Shared GCP project, Artifact Registry, WIF, and Secret Manager remain reusable. Runtime identities and permissions are least-privilege per component. Terraform owns resource definitions; application workflows own version publication. Do not store secret values in Terraform state. Never create an additional always-on service or change billing without reviewing the cost and approving the plan.

## Migration checklist

- [x] Establish independent application boundary and destination directory.
- [ ] Inventory every reference to `services/media/`, including Docker, Cloud Build, Terraform, GitHub Actions, scripts, and tests.
- [ ] Move existing code with compatibility and rollback; update all paths atomically.
- [ ] Introduce standalone API authentication, tenant isolation, and authorized R2 references.
- [ ] Validate Imagor + video thumbnail plugin; retain existing image job until proven equivalent.
- [ ] Add Range/206 and Safari video playback tests to the gateway.
- [ ] Add per-component CI, release selection, and isolated concurrency.
- [ ] Integrate the existing top-level release target.
- [ ] Verify Terraform plans show no unintended replacements or deletions.
- [ ] Run real private R2 fixtures and end-to-end tests before switching traffic.
- [ ] Retire the Sharp image job only after cutover and explicit approval.

Until these tasks are completed, `services/media/` remains the working implementation. This README is a migration contract, not a declaration that the target services are already deployed.
