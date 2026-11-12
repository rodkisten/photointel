# TF State bootstrap

The Terraform production backend cannot initialize until a private GCS state
bucket exists. Run **TF · State Bootstrap** in `plan` mode first, then in
`apply` with the authorization checkbox. It uses the existing dedicated
bootstrap WIF identity, not the deployment identity.

Default bucket: `photointel-terraform-state`, region `us-central1`.
An existing bucket is reused, never deleted. Versioning, uniform bucket-level
access and public access prevention are enforced on apply. Review IAM,
retention, lifecycle, encryption and deletion safeguards separately before
treating the bucket as production-ready.

Set GitHub Environment `production` variables:
- `TF_STATE_BUCKET=photointel-terraform-state`
- `TF_STATE_PREFIX=photointel/production`
- `TF_WORKLOAD_IDENTITY_PROVIDER` (dedicated Terraform WIF provider)
- `TF_SERVICE_ACCOUNT` (Terraform execution identity)

The bootstrap identity needs permission to create/update buckets. The
Terraform execution identity needs scoped object access to the state bucket,
plus the appropriate resource management permissions. These permissions
are **not** granted by this workflow.

**Safety:** Terraform plan can still propose creating resources already in
production if they have not been imported into state. Do not run TF Production
apply until the inventory and import process is complete.
