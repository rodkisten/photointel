# Opt-in independent Media Engine Imagor service. Existing media jobs remain untouched.
# An immutable image digest must be provided before enabling this resource.
variable "enable_media_imagor" {
  type        = bool
  default     = false
  description = "Explicit opt-in. Defaults to no new Cloud Run service or billing."
}
variable "media_imagor_image" {
  type        = string
  default     = ""
  description = "Reviewed immutable Artifact Registry media-imagor image digest."
  validation {
    condition = var.media_imagor_image == "" || can(regex(
      "^us-central1-docker[.]pkg[.]dev/photointel/photointel/media-imagor@sha256:[a-f0-9]{64}$",
      var.media_imagor_image
    ))
    error_message = "Provide an immutable media-imagor Artifact Registry digest."
  }
}
variable "media_imagor_max_instances" {
  type    = number
  default = 1
  validation {
    condition     = var.media_imagor_max_instances >= 1 && var.media_imagor_max_instances <= 3 && floor(var.media_imagor_max_instances) == var.media_imagor_max_instances
    error_message = "Imagor max instances must be an integer between 1 and 3."
  }
}

resource "google_cloud_run_v2_service" "media_imagor" {
  count               = var.enable_media_imagor ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = "photointel-media-imagor"
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account                  = google_service_account.identity["media"].email
    max_instance_request_concurrency = 2
    timeout                          = "30s"
    scaling {
      min_instance_count = 0
      max_instance_count = var.media_imagor_max_instances
    }
    containers {
      image = var.media_imagor_image
      ports { container_port = 8000 }
      resources {
        limits = { cpu = "1", memory = "1Gi" }
        cpu_idle = true
      }
      env {
        name  = "IMAGOR_SECRET"
        value_source {
          secret_key_ref {
            secret  = "photointel-media-imagor-secret"
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = can(regex("@sha256:[a-f0-9]{64}$", var.media_imagor_image))
      error_message = "Enable Imagor only with a verified immutable image digest."
    }
  }
  depends_on = [google_service_account_iam_member.terraform_media]
}

output "media_imagor_service" {
  value = var.enable_media_imagor ? {
    name = google_cloud_run_v2_service.media_imagor[0].name
    uri  = google_cloud_run_v2_service.media_imagor[0].uri
  } : null
}
