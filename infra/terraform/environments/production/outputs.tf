output "project_id" {
  value = var.project_id
}
output "artifact_registry" {
  value = google_artifact_registry_repository.docker.id
}
output "service_accounts" {
  value = { for k, v in google_service_account.identity : k => v.email }
}
output "media_jobs" {
  value = { for k, v in google_cloud_run_v2_job.media : k => v.name }
}
output "api_domain" {
  value = var.api_domain
}
output "manage_domain" {
  value = var.manage_domain
}
