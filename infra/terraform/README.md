# PhotoIntel Terraform migration

This is a **non-destructive adoption track**. Existing GitHub Actions and
`infra/gcp` scripts remain untouched. **Do not apply** until all resources
declared in the root are imported, and the first plan is reviewed.

## State bootstrap (one-time, administrative identity)

Create a dedicated private GCS bucket for Terraform state outside this root
with object versioning, uniform bucket-level access, public access prevention,
restricted IAM, and deletion protection. Set GitHub production variables:
`TF_STATE_BUCKET`, `TF_STATE_PREFIX` (e.g. `photointel/production`),
`TF_WORKLOAD_IDENTITY_PROVIDER`, and `TF_SERVICE_ACCOUNT`.
The WIF principal must have state bucket read/write access and scoped
permissions to manage only the imported resources. Never store tokens in tfvars.

## Adoption checklist

1. Inventory the live project and Cloudflare resources before declaring them.
2. Run `terraform fmt -recursive infra/terraform` and `terraform validate`.
3. Initialize with `terraform init -backend-config=bucket=... -backend-config=prefix=...`.
4. Import each existing identity, registry, bucket and IAM membership. Example:
   `terraform import 'google_service_account.identity["deployer"]' projects/photointel/serviceAccounts/photointel-deployer@photointel.iam.gserviceaccount.com`
5. For every enabled service/job, import its live resource ID **before** enabling it.
6. Compare each imported resource against the live configuration, especially
   Cloud Run environment, secrets, ingress, traffic, scaling and IAM.
7. Review `terraform plan` until it proposes no unexpected modifications,
   replacements or deletions. Preserve existing IAM via member resources.
8. Only after acceptance, use the TF production workflow for changes.

## Scope and boundaries

The `production` state now models the API, existing finite processing Jobs,
Media Jobs, runtime secret IAM, service identities, deployer IAM, Artifact
Registry and source buckets. The API and processing adoption inventory preserves
live images, runtime identities, CPU/memory, probes, scaling, timeout, traffic,
extra environment and conditional invoker IAM. Configuration changes merge the
configured env names while retaining extra live names. Missing unused processors
are not created; a missing resource already in state fails closed.

The isolated `cloudflare` state models the three PhotoIntel custom domains,
existing Access applications/policies for photos and Manage, Manage D1, the
existing private R2 bucket and both Workers' cron triggers. It excludes the
separate Access app on the apex migos.club. Worker versions, assets, bindings,
secrets and D1 schema migrations remain in the unified frontend pipeline.
Wrangler publication uses `versions upload` and `versions deploy`, which do not
reconcile Terraform-owned domains or triggers.

WIF providers/initial credentials remain bootstrap-owned. Cloud Scheduler and
the temporary iCloud diagnostic Job remain in the existing operations scripts;
they are not adopted by this API/Worker migration. No old resource is deleted.

Legacy API, processing Job, auth sync and Cloudflare infrastructure writers are
disabled or forwarded to TF Production. Bootstrap no longer grants runtime
secret access to API/processors; Terraform owns those per-secret grants. Never run Terraform and bootstrap IAM reconciliation concurrently.

Terraform state may contain sensitive metadata. Do not manage secret payloads
through Terraform; keep values in Secret Manager.

## Media Engine ownership and release flow

Terraform is the only writer of `photointel-media-image` and
`photointel-media-video`. The former Python `media-jobs-deploy --apply` path
refuses writes. Read-only legacy command previews remain available.

- `Media · plan` dispatches `TF · Production` with action `plan` and waits.
- `Media · jobs-deploy` dispatches a reviewed, non-destructive TF apply and waits
  for both Jobs to be described and verified. It never builds images.
- `Media · build` publishes images only. `build-and-deploy` builds once, then
  passes that full source SHA to Terraform.
- A blank `image_sha` preserves the release recorded in remote state. The first
  adoption uses the already-published `f6b667c5da7d49ee6d1d059ae8dd4f8159a477cc`.
  Artifact Registry tags are resolved to immutable digests during Plan.

The media workflow uses its scoped Actions token to dispatch the existing TF
workflow; privileged WIF remains restricted to TF Production. No new secret or
WIF bootstrap run is needed. Both workflows retain their separate concurrency
queues; Terraform also locks the shared remote state.

After Init, `python3 -m infra.terraform.media_release prepare` inventories both
Jobs, preserves the recorded image source, and generates temporary declarative
import blocks for existing Jobs absent from state. Only an explicit NOT_FOUND
allows a new Job; permission failures stop adoption. Additional execution
settings must be modeled before adoption to avoid silently removing them.

Review the complete Plan, including imports, digest pinning, resource limits,
secret references and the scoped Terraform runtime `actAs` binding. Deletions
and replacements are blocked for the whole root; both Jobs additionally have
`prevent_destroy` and `deletion_protection`. Apply uses that exact saved plan.
Secret payloads are never read into state; the runtime receives only the three
R2 secret references, with accessor IAM scoped to each secret.

Run from the repository root for a local administrative workflow:

```bash
terraform -chdir=infra/terraform/environments/production init
python3 -m infra.terraform.media_release prepare
terraform -chdir=infra/terraform/environments/production plan -out=tfplan
python3 -m infra.terraform.media_release review
# Only after inspecting the complete plan:
terraform -chdir=infra/terraform/environments/production apply tfplan
python3 -m infra.terraform.media_release verify
```

Offline validation: `terraform init -backend=false`, `terraform validate`, and
`terraform test` from the production directory, plus
`python3 -m unittest infra.gcp.tests.test_media_terraform -v` from the repo root.

## API and Cloudflare migration / next operations

Use `TF · Production` with `action=plan`, first `scope=gcp`, then
`scope=cloudflare`. Keep `api_sha` and `image_sha` blank for adoption without a
build. Review each Plan before `action=apply` with the checkbox authorized.
The same workflow retains its existing WIF allowlist; no bootstrap credential
change is needed. Cloudflare state uses `TF_CF_STATE_PREFIX` (default
`photointel/cloudflare`); GCP keeps `TF_STATE_PREFIX` (default
`photointel/production`) in the existing private state bucket.

Cloudflare preparation reads existing metadata using the existing deployment
token from Secret Manager. It generates resource JSON against the pinned
provider schema, with declarative imports and `prevent_destroy` on every
resource. Adopted desired metadata is retained in private state on later runs;
configured email allowlists update only the named PhotoIntel email policies.
Provider-computed fields and SCIM credentials are excluded. No Worker source or
secret payload is stored in Terraform. Generated `.auto.tf.json`/`.tfvars.json`
are private, ignored runtime files, not source artifacts.

For a release, build once, then supply that full published commit as `api_sha`.
A blank SHA uses the ready API digest and each processor's existing digest.
`runtime_targets` preserves the config-sync selector (`api`, `jobs`, or both).
The release workflow dispatches Terraform instead of `run services/jobs replace`;
build, migration checks, scheduler operations, diagnostics and temporary probes
still use the shared gcloud transport. `release.sh` therefore remains necessary,
but no longer deploys production API/processor definitions itself.

The GCP Apply verifies API readiness and its image/env plus processing image and
runtime identity. The Cloudflare Apply verifies domains, Access, D1, R2 and cron
metadata. Unknown sidecars, volumes, custom networking, inline credentials or
unsupported probes stop adoption and require explicit modeling, rather than
silently dropping live settings. Split/pinned API traffic blocks a new image
release until its intended traffic migration is reviewed.

## Compact Release UI

Use `🚀 Release` on main. Its five short fields are `Ação`, `Destino`, `Origem`,
`SHA opcional` and `Confirmar`. Targets: `api`, `media`, `web`, `manage`, `all`.

- An explicit full SHA wins over the source selector and must be an ancestor of main.
- `main` selects the workflow's main commit. `last` selects the latest published
  API image, latest common source of both media images, or deployed Worker source.
- `build` tests/publishes without deploy; existing immutable images are reused.
- `deploy` and `build-and-deploy` build missing container images once, then use
  Terraform. Failed build/verification stops that target before deploy.
- Worker build/deploy uses the existing unified frontend workflow, filtered to
  the selected app. Historical apps/packages are restored from the chosen SHA;
  trusted deployment tooling remains on main. Version publication records its
  true source SHA, so `last` never mistakes the orchestrator commit for the code.
- `plan` never builds. With main and blank SHA it reviews infrastructure against
  existing images. An explicit SHA/last selects the published image to review.
- API deployment retains the read-only Neon schema gate. No migration is automatic.
- `all` serializes targets to avoid competing dispatches in the shared TF queue.

Existing workflows remain available for compatibility and specialized operations.
No token or secret input is added to the release form.
