variable "project_id" {
  type    = string
  default = "photointel"
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "repository" {
  type    = string
  default = "photointel"
}
variable "cloudflare_account_id" {
  type    = string
  default = ""
}
variable "cloudflare_zone_id" {
  type    = string
  default = ""
}
variable "manage_domain" {
  type    = string
  default = "photos-manage.migos.club"
}
variable "api_domain" {
  type    = string
  default = "photointel-api.migos.club"
}
# Workflow preparation preserves the release already recorded in remote state.
variable "media_image_sha" {
  type        = string
  default     = "f6b667c5da7d49ee6d1d059ae8dd4f8159a477cc"
  description = "Full source commit of both published media images; resolved to digests at Plan."
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.media_image_sha))
    error_message = "media_image_sha must be a full lowercase Git commit SHA."
  }
}
variable "media_bucket" {
  type    = string
  default = "photointel"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.media_bucket))
    error_message = "media_bucket must be a valid R2 bucket name."
  }
}
variable "media_image_digests" {
  type        = map(string)
  default     = {}
  description = "Digests from the previously applied release; set by workflow preparation."
  validation {
    condition = alltrue([for kind, image in var.media_image_digests :
      contains(["image", "video"], kind) && can(regex("^us-central1-docker[.]pkg[.]dev/photointel/photointel/media-${kind}@sha256:[a-f0-9]{64}$", image))
    ])
    error_message = "Only immutable digests for the two PhotoIntel media images are accepted."
  }
}
variable "api_image" {
  type    = string
  default = ""
}
variable "manage_worker_name" {
  type    = string
  default = "photointel-manage"
}
# Retained for compatibility, but disabling managed production Jobs is forbidden.
variable "enable_media_jobs" {
  type    = bool
  default = true
  validation {
    condition     = var.enable_media_jobs
    error_message = "Media Jobs are permanently managed; disabling them would destroy resources."
  }
}
variable "enable_api_service" {
  type    = bool
  default = false
}
variable "enable_cloudflare" {
  type    = bool
  default = false
}
variable "manage_secret_names" {
  type    = set(string)
  default = []
}
variable "service_accounts" {
  type    = set(string)
  default = ["api", "jobs", "migrate", "scheduler", "builder", "deployer", "bootstrap", "media", "manage"]
}

variable "api_definition" {
  description = "Validated API spec generated from production config and live settings; references only, never secret payloads."
  type        = any
  default     = null
}
variable "processing_jobs" {
  description = "Finite processing Jobs adopted from existing deployments."
  type        = any
  default     = {}
}
variable "api_invokers" {
  description = "Existing API transport IAM, including conditions; never inferred from a deploy flag."
  type        = any
  default     = {}
}
variable "processing_invokers" {
  type    = any
  default = {}
}
