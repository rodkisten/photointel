# Terraform is the sole writer of Media Job definitions. Builds remain separate.
locals {
  media_jobs = {
    image = { cpu = "1", memory = "1Gi", timeout = "600s" }
    video = { cpu = "2", memory = "2Gi", timeout = "1800s" }
  }
  media_secret_env = {
    R2_ENDPOINT          = "photointel-r2-endpoint"
    R2_ACCESS_KEY_ID     = "photointel-r2-access-key"
    R2_SECRET_ACCESS_KEY = "photointel-r2-secret-key"
  }
  media_images = {
    for kind in keys(local.media_jobs) : kind => contains(keys(var.media_image_digests), kind) ? var.media_image_digests[kind] : data.google_artifact_registry_docker_image.media[kind].self_link
  }
}

data "google_artifact_registry_docker_image" "media" {
  for_each      = { for kind, settings in local.media_jobs : kind => settings if !contains(keys(var.media_image_digests), kind) }
  project       = var.project_id
  location      = var.region
  repository_id = var.repository
  image_name    = "media-${each.key}:${var.media_image_sha}"
}

resource "google_cloud_run_v2_job" "media" {
  for_each            = local.media_jobs
  project             = var.project_id
  name                = "photointel-media-${each.key}"
  location            = var.region
  deletion_protection = true
  labels              = { "photointel-source-sha" = var.media_image_sha }
  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.identity["media"].email
      max_retries     = 0
      timeout         = each.value.timeout
      containers {
        image = local.media_images[each.key]
        resources {
          limits = { cpu = each.value.cpu, memory = each.value.memory }
        }
        env {
          name  = "R2_BUCKET"
          value = var.media_bucket
        }
        dynamic "env" {
          for_each = local.media_secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
  # IAM must propagate before Cloud Run validates secret access at deployment.
  depends_on = [google_secret_manager_secret_iam_member.media_runtime, google_service_account_iam_member.terraform_media]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = can(regex("@sha256:[a-f0-9]{64}$", local.media_images[each.key]))
      error_message = "Media deployments require an immutable Artifact Registry digest."
    }
  }
}

# Terraform attaches the same runtime identity as the former WIF deployer.
# Scope actAs to this account, rather than granting it project-wide.
resource "google_service_account_iam_member" "terraform_media" {
  service_account_id = google_service_account.identity["media"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:photointel-terraform@${var.project_id}.iam.gserviceaccount.com"
}

# Saved in remote state, so an unrelated infrastructure apply keeps this release.
output "media_release" {
  value = {
    source_sha = var.media_image_sha
    bucket     = var.media_bucket
    images     = local.media_images
  }
}
