# PhotoIntel Media Engine: deployment and provisioning

## Safety contract

- Never modify Cloudflare billing, enable paid services or create a billing account.
- `infra/gcp/manage.py` remains the **only Python deployment entrypoint**.
- Every GCP command uses `infra/gcp/cloud_cli.py` for project scoping,
  full-width syntax-highlighted command previews and sanitized errors.
- All mutations require `--apply --authorize-charges --confirm-project photointel`.
  This is an **authorization gate**, not a claim that charges cannot occur.
- `main` API, migrations, scheduler and existing jobs are not changed by
  `media-build` or `media-jobs-deploy`.
- No Cloudflare Worker deploy is automatic. Its R2 binding and secrets must be
  reviewed and configured separately.

## Existing prerequisites (operator review)

1. Existing Artifact Registry repository `photointel` in `us-central1`.
2. Existing service account `photointel-media@photointel.iam.gserviceaccount.com`
   with permission to read the three Secret Manager secrets below.
3. Secrets with versions: `photointel-media-r2-endpoint`,
   `photointel-media-r2-access-key`, `photointel-media-r2-secret-key`.
   Use a least-privilege R2 credential scoped to the existing bucket.
4. A verified 40-character Git source commit SHA, with matching source checkout.
5. Cloud Build and Cloud Run IAM permissions and an explicit operator-approved
   budget/cost assessment. **Do not enable billing**.

The media job uses Secret Manager references and an explicit dedicated service
account. It does not provision those prerequisites. The existing bootstrap
currently creates signing secrets only, not R2 tokens or service accounts.

## Local Docker Compose (development only)

```bash
cd services/media
docker compose config
docker compose up -d imagor
# Optional R2-backed batch jobs; set secrets locally without committing .env:
docker compose --profile image run --rm image
docker compose --profile video run --rm video
docker compose down
```

Imagor uses `IMAGOR_UNSAFE=1` **only on 127.0.0.1:8008**.
Never expose this configuration in production. The image and video jobs are
opt-in profiles; plain `docker compose up` does not run them.

## Build and deploy through the existing Python CLI

```bash
# Run from the repository root; substitute the verified source SHA.
python -m unittest infra.gcp.tests.test_media -v
python -m infra.gcp.manage media-build --git-sha FULL_40_CHARACTER_SHA
python -m infra.gcp.manage media-jobs-deploy --git-sha FULL_40_CHARACTER_SHA

# Only after explicit approval of potentially charge-incurring operations:
python -m infra.gcp.manage media-build --git-sha FULL_40_CHARACTER_SHA \
  --apply --authorize-charges --confirm-project photointel
python -m infra.gcp.manage media-jobs-deploy --git-sha FULL_40_CHARACTER_SHA \
  --apply --authorize-charges --confirm-project photointel
```

The build produces `media-image`, `media-video` and `media-imagor`
container images. The deploy action updates **only** two private Cloud Run
Jobs: `photointel-media-image` and `photointel-media-video`. It does not
publish Imagor as a Cloud Run Service.

Jobs receive `MEDIA_INPUT_KEY`, `MEDIA_OUTPUT_KEY` and transformation
parameters as **execution-time overrides** from a trusted dispatcher.
No public job invocation or arbitrary R2 object selection is permitted.

## Remaining release blockers

- Trusted dispatcher and per-user authorization, retry/idempotency, job state.
- Worker signing secret provisioning and secure backend integration.
- Imagor private loader, ImagorVideo, version-pinned image.
- Video range requests, bounded input streaming, watermark font validation.
- End-to-end image/video tests with representative private R2 fixtures.
- Cloudflare Worker staged deployment, rollback, Safari validation.
- Audit Cloud Build source SHA verification, IAM permissions and actual cost.

**Not production-ready** until all blockers are addressed and validated.
