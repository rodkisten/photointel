# Offline provider mocks validate the real HCL, without reading secrets or GCP.
mock_provider "google" {}
mock_provider "cloudflare" {}

override_data {
  target = data.google_artifact_registry_docker_image.media["image"]
  values = {
    self_link = "us-central1-docker.pkg.dev/photointel/photointel/media-image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
override_data {
  target = data.google_artifact_registry_docker_image.media["video"]
  values = {
    self_link = "us-central1-docker.pkg.dev/photointel/photointel/media-video@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}

run "media_job_configuration" {
  command = plan
  assert {
    condition     = length(google_cloud_run_v2_job.media) == 2
    error_message = "Both Media Jobs must always remain managed."
  }
  assert {
    condition     = alltrue([for job in google_cloud_run_v2_job.media : job.deletion_protection && job.template[0].task_count == 1 && job.template[0].parallelism == 1 && job.template[0].template[0].max_retries == 0])
    error_message = "Deletion protection, task count, parallelism and retries must match production."
  }
  assert {
    condition     = google_cloud_run_v2_job.media["image"].template[0].template[0].timeout == "600s" && google_cloud_run_v2_job.media["video"].template[0].template[0].timeout == "1800s"
    error_message = "Media timeouts must match the previous deploy."
  }
  assert {
    condition     = google_cloud_run_v2_job.media["video"].template[0].template[0].containers[0].resources[0].limits == tomap({ cpu = "2", memory = "2Gi" })
    error_message = "Video CPU and memory must be preserved."
  }
  assert {
    condition     = alltrue([for job in google_cloud_run_v2_job.media : length(job.template[0].template[0].containers[0].env) == 4])
    error_message = "Each Job requires the bucket and three secret references."
  }
}
