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

Currently modeled: project deployer IAM, service accounts, Artifact Registry,
source bucket, optional Secret Manager containers, optional API service and
production Media Image/Video Jobs. Media Jobs are permanently enabled and
fully modeled; the optional API remains a skeleton and must be expanded to
match its live configuration before import.
Cloudflare resources, WIF pool/providers, Cloud Scheduler, all other Cloud Run
services, DNS, Access, R2 and Manage integration are **not migrated yet**.

Existing scripts and workflows remain authoritative until explicitly retired
after import. Never run Terraform and bootstrap IAM reconciliation concurrently.

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
