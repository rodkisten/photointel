locals {
  deployer = "serviceAccount:photointel-deployer@${var.project_id}.iam.gserviceaccount.com"
  builder  = "serviceAccount:photointel-builder@${var.project_id}.iam.gserviceaccount.com"
  api     = "serviceAccount:photointel-api@${var.project_id}.iam.gserviceaccount.com"
  media   = "photointel-media@${var.project_id}.iam.gserviceaccount.com"
  build_roles = toset([
    "roles/cloudbuild.builds.editor",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/run.admin",
    "roles/cloudscheduler.admin",
    "roles/artifactregistry.reader",
    "roles/logging.viewer",
  ])
}
# Import existing resources before allowing any apply. IAM members are additive
# and deliberately do not replace full project IAM policies.
resource "google_service_account" "identity" {
  for_each = var.service_accounts
  account_id = "photointel-${each.key}"
  display_name = "PhotoIntel ${each.key}"
}
resource "google_project_iam_member" "deployer" {
  for_each = local.build_roles
  project = var.project_id
  role = each.key
  member = local.deployer
}
resource "google_service_account_iam_member" "deployer_builder" {
  service_account_id = google_service_account.identity["builder"].name
  role = "roles/iam.serviceAccountUser"
  member = local.deployer
}
resource "google_artifact_registry_repository" "docker" {
  location = var.region
  repository_id = var.repository
  format = "DOCKER"
  description = "Private PhotoIntel images"
  lifecycle {
    prevent_destroy = true
  }
}
resource "google_storage_bucket" "build_source" {
  name = "${var.project_id}-photointel-build-source"
  # Existing bucket was provisioned in the US multi-region. Location is immutable.
  location = "US"
  uniform_bucket_level_access = true
  public_access_prevention = "enforced"
  versioning {
    enabled = true
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
  role = "roles/storage.objectViewer"
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
  location = google_artifact_registry_repository.docker.location
  repository = google_artifact_registry_repository.docker.name
  role = "roles/artifactregistry.writer"
  member = local.builder
}
resource "google_secret_manager_secret" "existing" {
  for_each = var.manage_secret_names
  secret_id = each.key
  replication {
    auto {}
  }
  lifecycle { prevent_destroy = true }
}
resource "google_cloud_run_v2_job" "media" {
  for_each = var.enable_media_jobs ? {
    image = var.media_image
    video = var.media_video
  } : {}
  name = "photointel-media-${each.key}"
  location = var.region
  deletion_protection = true
  template {
    template {
      service_account = local.media
      containers {
        image = each.value
      }
      max_retries = 1
    }
  }
  lifecycle {
    precondition {
      condition = length(each.value) > 0
      error_message = "Provide immutable media image digests before enabling media jobs."
    }
  }
}
resource "google_cloud_run_v2_service" "api" {
  count = var.enable_api_service ? 1 : 0
  name = "photointel-api"
  location = var.region
  deletion_protection = true
  template {
    service_account = google_service_account.identity["api"].email
    containers {
      image = var.api_image
    }
  }
  lifecycle {
    precondition {
      condition = length(var.api_image) > 0
      error_message = "Provide the existing API image before enabling the service."
    }
  }
}
