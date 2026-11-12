variable "project_id" {
  type = string
  default = "photointel"
}
variable "region" {
  type = string
  default = "us-central1"
}
variable "repository" {
  type = string
  default = "photointel"
}
variable "cloudflare_account_id" {
  type = string
  default = ""
}
variable "cloudflare_zone_id" {
  type = string
  default = ""
}
variable "manage_domain" {
  type = string
  default = "photos-manage.migos.club"
}
variable "api_domain" {
  type = string
  default = "photointel-api.migos.club"
}
variable "media_image" {
  type = string
  default = ""
}
variable "media_video" {
  type = string
  default = ""
}
variable "api_image" {
  type = string
  default = ""
}
variable "manage_worker_name" {
  type = string
  default = "photointel-manage"
}
variable "enable_media_jobs" {
  type = bool
  default = false
}
variable "enable_api_service" {
  type = bool
  default = false
}
variable "enable_cloudflare" {
  type = bool
  default = false
}
variable "manage_secret_names" {
  type = set(string)
  default = []
}
variable "service_accounts" {
  type = set(string)
  default = ["api", "jobs", "migrate", "scheduler", "builder", "deployer", "bootstrap", "media", "manage"]
}
