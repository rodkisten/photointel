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
Media Image/Video Jobs. These optional resources are disabled by default.
The API and jobs definitions are **skeletons**, not production-equivalent
representations: they must be expanded to match live resources before import.
Cloudflare resources, WIF pool/providers, Cloud Scheduler, all other Cloud Run
services, DNS, Access, R2 and Manage integration are **not migrated yet**.

Existing scripts and workflows remain authoritative until explicitly retired
after import. Never run Terraform and bootstrap IAM reconciliation concurrently.

Terraform state may contain sensitive metadata. Do not manage secret payloads
through Terraform; keep values in Secret Manager.
