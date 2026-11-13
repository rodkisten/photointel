terraform {
  required_version = ">= 1.17.2, < 1.18.0"
  required_providers {
    google = {
      source = "hashicorp/google"
      version = "~> 6.0"
    }
  }
  backend "gcs" {}
}

provider "google" {
  project = "photointel"
}

# This independent state is owned by the administrative bootstrap identity.
# Do not grant the production deployer permission to edit its own IAM.
# FIXME: Extend this root with audited, least-privilege grants for other
# services after migrating ownership out of legacy bootstrap scripts.
resource "google_bigquery_dataset_iam_member" "terraform_billing_dataset_owner" {
  project    = "photointel"
  dataset_id = "custos"
  role       = "roles/bigquery.dataOwner"
  member     = "serviceAccount:photointel-deployer@photointel.iam.gserviceaccount.com"
}
