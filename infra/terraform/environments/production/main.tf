locals {
  deployer = "serviceAccount:photointel-deployer@${var.project_id}.iam.gserviceaccount.com"
  builder  = "serviceAccount:photointel-builder@${var.project_id}.iam.gserviceaccount.com"
  api      = "serviceAccount:photointel-api@${var.project_id}.iam.gserviceaccount.com"
  media    = "photointel-media@${var.project_id}.iam.gserviceaccount.com"
  # Must match REQUIRED_SECRET_ENV in infra/gcp/media.py. Terraform owns only
  # these access bindings; secret values remain outside Terraform/state.
  media_secret_names = toset([
    "photointel-r2-endpoint",
    "photointel-r2-access-key",
    "photointel-r2-secret-key",
  ])
  build_roles = toset([
    "roles/cloudbuild.builds.editor",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/run.admin",
    "roles/cloudscheduler.admin",
    "roles/artifactregistry.reader",
    "roles/logging.viewer",
    "roles/secretmanager.secretAccessor",
  ])
}
# Import existing resources before allowing any apply. IAM members are additive
# and deliberately do not replace full project IAM policies.
resource "google_service_account" "identity" {
  for_each     = var.service_accounts
  account_id   = "photointel-${each.key}"
  display_name = "PhotoIntel ${each.key}"
}
resource "google_project_iam_member" "deployer" {
  for_each = local.build_roles
  project  = var.project_id
  role     = each.key
  member   = local.deployer
}
resource "google_service_account_iam_member" "deployer_builder" {
  service_account_id = google_service_account.identity["builder"].name
  role               = "roles/iam.serviceAccountUser"
  member             = local.deployer
}
# The deployer must be allowed to attach the media runtime identity to Cloud Run Jobs.
# Grant only on that service account, not across the entire project.
resource "google_service_account_iam_member" "deployer_media" {
  service_account_id = google_service_account.identity["media"].name
  role               = "roles/iam.serviceAccountUser"
  member             = local.deployer
}
# Read metadata during Plan so a missing secret is caught before deployment.
# Do not read secret versions or payloads into Terraform state.
data "google_secret_manager_secret" "media" {
  for_each  = local.media_secret_names
  project   = var.project_id
  secret_id = each.key
}
resource "google_secret_manager_secret_iam_member" "media_runtime" {
  for_each  = data.google_secret_manager_secret.media
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.identity["media"].email}"
}
resource "google_artifact_registry_repository" "docker" {
  location      = var.region
  repository_id = var.repository
  format        = "DOCKER"
  description   = "Private PhotoIntel images"

  # Keep the two newest versions per image package, even if older than
  # the deletion threshold. DELETE policies never override KEEP policies.
  cleanup_policies {
    id     = "keep-two-most-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 2
    }
  }
  # Allow seven days for diagnosing a failed build and completing a rollout.
  cleanup_policies {
    id     = "delete-old-images"
    action = "DELETE"
    condition {
      older_than = "604800s"
      tag_state  = "ANY"
    }
  }
  cleanup_policy_dry_run = true

  lifecycle {
    prevent_destroy = true
  }
}
resource "google_storage_bucket" "build_source" {
  name = "${var.project_id}-photointel-build-source"
  # Existing bucket was provisioned in the US multi-region. Location is immutable.
  location                    = "US"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Source archives are disposable. Preserve the bucket, not every upload.
  versioning {
    enabled = false
  }
  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age        = 7
      with_state = "LIVE"
    }
  }
  # Clean up noncurrent versions left behind by the previous configuration.
  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age        = 2
      with_state = "ARCHIVED"
    }
  }
  lifecycle { prevent_destroy = true }
}
# The GitHub WIF deployer uploads the Cloud Build source archive.
resource "google_storage_bucket_iam_member" "deployer_source" {
  bucket = google_storage_bucket.build_source.name
  role   = "roles/storage.objectAdmin"
  member = local.deployer
}
resource "google_storage_bucket_iam_member" "builder_source" {
  bucket = google_storage_bucket.build_source.name
  role   = "roles/storage.objectViewer"
  member = local.builder
}
# The Cloud Build CLI uploads sources to the pre-existing default bucket.
# IAM membership is additive: do not recreate/import or destroy this bucket.
# This is owned by Terraform, not the bootstrap IAM reconciliation.
resource "google_storage_bucket_iam_member" "cloudbuild_deployer_objects" {
  bucket = "${var.project_id}_cloudbuild"
  role   = "roles/storage.objectAdmin"
  member = local.deployer
}

resource "google_storage_bucket_iam_member" "cloudbuild_builder_objects" {
  bucket = "${var.project_id}_cloudbuild"
  role   = "roles/storage.objectViewer"
  member = local.builder
}

resource "google_artifact_registry_repository_iam_member" "builder_push" {
  location   = google_artifact_registry_repository.docker.location
  repository = google_artifact_registry_repository.docker.name
  role       = "roles/artifactregistry.writer"
  member     = local.builder
}
# GitHub Actions Buildx publishes directly to Artifact Registry via WIF.
# Repository-scoped permission avoids granting project-wide write access.
resource "google_artifact_registry_repository_iam_member" "github_buildx_push" {
  location   = google_artifact_registry_repository.docker.location
  repository = google_artifact_registry_repository.docker.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:photointel-terraform@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_secret_manager_secret" "existing" {
  for_each  = var.manage_secret_names
  secret_id = each.key
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
}

# The Manage Worker impersonates this service account through WIF.
# BigQuery job creation is project-scoped; billing data access is dataset-scoped.
# Billing export setup itself belongs to the Cloud Billing console.
resource "google_project_iam_member" "manage_billing_query_jobs" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.identity["manage"].email}"
}

resource "google_bigquery_dataset_iam_member" "manage_billing_reader" {
  project    = var.billing_export_project_id
  dataset_id = var.billing_export_dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.identity["manage"].email}"
}
