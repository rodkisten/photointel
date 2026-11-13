# TF · Permissions

Independent, additive IAM management for PhotoIntel. Uses the dedicated
`photointel-bootstrap` administrative identity and the separate
`photointel/permissions` GCS state prefix.

The initial grant gives `photointel-deployer` `roles/bigquery.dataOwner`
**only on** `photointel:custos`. It addresses the BigQuery dataset IAM read
failure during the production Terraform apply. It does not modify billing
export tables, data, or dataset creation.

## First run

1. Ensure the bootstrap identity can read and change dataset IAM and access
   the private Terraform state bucket. If it cannot, an administrator must
   grant that access once; Terraform cannot bootstrap its own privileges.
2. Run **TF · Permissions** with `mode=plan` from main and inspect the plan.
3. Run `mode=apply` with `authorize_apply=true`.
4. Re-run the failed **TF · Production** plan/apply.

**Important:** If the same dataset IAM member already exists, import it into
this separate state before apply to avoid ownership conflicts. Do not manage
the same member resource from two Terraform states. Production already owns
the separate Manage service account's `roles/bigquery.dataViewer` grant.

FIXME: Add a preflight that detects already-managed IAM members and offers a
safe import-only path. Never automate broad project IAM grants.
