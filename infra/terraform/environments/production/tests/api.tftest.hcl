mock_provider "google" {}
mock_provider "cloudflare" {}
override_data {
  target = data.google_artifact_registry_docker_image.media["image"]
  values = { self_link = "us-central1-docker.pkg.dev/photointel/photointel/media-image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
}
override_data {
  target = data.google_artifact_registry_docker_image.media["video"]
  values = { self_link = "us-central1-docker.pkg.dev/photointel/photointel/media-video@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
}

run "adopted_api_settings" {
  command = plan
  variables {
    enable_api_service = true
    api_definition = {
      ingress        = "INGRESS_TRAFFIC_ALL", service_account = "photointel-api@photointel.iam.gserviceaccount.com"
      concurrency    = 8, timeout = "300s", execution_environment = null
      min_instances  = 0, max_instances = 3
      image          = "us-central1-docker.pkg.dev/photointel/photointel/api@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      command        = ["python"], args = ["/app/infra/gcp/entrypoint.py"], port = 8080
      limits         = { cpu = "1", memory = "1Gi" }, cpu_idle = true, startup_cpu_boost = false
      env            = [{ name = "DATABASE_URL", secret = "photointel-database-url", version = "1" }]
      startup_probe  = { httpGet = { path = "/health/live", port = 8080 }, periodSeconds = 10, timeoutSeconds = 5, failureThreshold = 12 }
      liveness_probe = { httpGet = { path = "/health/live", port = 8080 }, periodSeconds = 30, timeoutSeconds = 5, failureThreshold = 3 }
      traffic        = [{ latestRevision = true, percent = 100 }]
    }
  }
  assert {
    condition     = google_cloud_run_v2_service.api[0].deletion_protection && google_cloud_run_v2_service.api[0].template[0].scaling[0].min_instance_count == 0
    error_message = "API deletion protection and scale-to-zero must be retained."
  }
  assert {
    condition     = google_cloud_run_v2_service.api[0].template[0].max_instance_request_concurrency == 8 && google_cloud_run_v2_service.api[0].template[0].timeout == "300s"
    error_message = "API concurrency/timeout changed during adoption."
  }
  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.api_transport) == 0
    error_message = "No public invoker may be inferred from an API deployment."
  }
}
