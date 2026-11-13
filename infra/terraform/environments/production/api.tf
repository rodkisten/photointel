# Config/image release preparation imports existing resources declaratively.
# No run services/jobs replace/update commands may write these definitions.
resource "google_cloud_run_v2_service" "api" {
  count               = var.enable_api_service ? 1 : 0
  project             = var.project_id
  name                = "photointel-api"
  location            = var.region
  deletion_protection = true
  ingress             = var.api_definition.ingress
  template {
    service_account                  = var.api_definition.service_account
    max_instance_request_concurrency = var.api_definition.concurrency
    timeout                          = var.api_definition.timeout
    execution_environment            = var.api_definition.execution_environment
    session_affinity                 = lookup(var.api_definition, "session_affinity", false)
    scaling {
      min_instance_count = var.api_definition.min_instances
      max_instance_count = var.api_definition.max_instances
    }
    containers {
      image   = var.api_definition.image
      command = var.api_definition.command
      args    = var.api_definition.args
      ports {
        container_port = var.api_definition.port
        name           = lookup(var.api_definition, "port_name", "http1")
      }
      resources {
        limits            = var.api_definition.limits
        cpu_idle          = var.api_definition.cpu_idle
        startup_cpu_boost = var.api_definition.startup_cpu_boost
      }
      dynamic "env" {
        for_each = var.api_definition.env
        content {
          name  = env.value.name
          value = lookup(env.value, "value", null)
          dynamic "value_source" {
            for_each = lookup(env.value, "secret", null) == null ? [] : [env.value]
            content {
              secret_key_ref {
                secret  = value_source.value.secret
                version = value_source.value.version
              }
            }
          }
        }
      }
      dynamic "startup_probe" {
        for_each = var.api_definition.startup_probe == null ? [] : [var.api_definition.startup_probe]
        content {
          initial_delay_seconds = lookup(startup_probe.value, "initialDelaySeconds", 0)
          timeout_seconds       = lookup(startup_probe.value, "timeoutSeconds", 1)
          period_seconds        = lookup(startup_probe.value, "periodSeconds", 10)
          failure_threshold     = lookup(startup_probe.value, "failureThreshold", 3)
          dynamic "http_get" {
            for_each = lookup(startup_probe.value, "httpGet", null) == null ? [] : [startup_probe.value.httpGet]
            content {
              path = lookup(http_get.value, "path", "/")
              port = lookup(http_get.value, "port", 8080)
              dynamic "http_headers" {
                for_each = lookup(http_get.value, "httpHeaders", [])
                content {
                  name  = http_headers.value.name
                  value = http_headers.value.value
                }
              }
            }
          }
          dynamic "tcp_socket" {
            for_each = lookup(startup_probe.value, "tcpSocket", null) == null ? [] : [startup_probe.value.tcpSocket]
            content { port = lookup(tcp_socket.value, "port", 8080) }
          }
        }
      }
      dynamic "liveness_probe" {
        for_each = var.api_definition.liveness_probe == null ? [] : [var.api_definition.liveness_probe]
        content {
          initial_delay_seconds = lookup(liveness_probe.value, "initialDelaySeconds", 0)
          timeout_seconds       = lookup(liveness_probe.value, "timeoutSeconds", 1)
          period_seconds        = lookup(liveness_probe.value, "periodSeconds", 10)
          failure_threshold     = lookup(liveness_probe.value, "failureThreshold", 3)
          http_get {
            path = lookup(liveness_probe.value.httpGet, "path", "/")
            port = lookup(liveness_probe.value.httpGet, "port", 8080)
            dynamic "http_headers" {
              for_each = lookup(liveness_probe.value.httpGet, "httpHeaders", [])
              content {
                name  = http_headers.value.name
                value = http_headers.value.value
              }
            }
          }
        }
      }
    }
  }
  dynamic "traffic" {
    for_each = var.api_definition.traffic
    content {
      type     = lookup(traffic.value, "latestRevision", false) ? "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST" : "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"
      revision = lookup(traffic.value, "latestRevision", false) ? null : lookup(traffic.value, "revisionName", null)
      percent  = lookup(traffic.value, "percent", 0)
      tag      = lookup(traffic.value, "tag", null)
    }
  }
  depends_on = [google_service_account_iam_member.terraform_api, google_secret_manager_secret_iam_member.runtime]
  lifecycle { prevent_destroy = true }
}

resource "google_service_account_iam_member" "terraform_api" {
  for_each           = toset(["api", "jobs"])
  service_account_id = google_service_account.identity[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:photointel-terraform@${var.project_id}.iam.gserviceaccount.com"
}

# Adopt only the API's current invoker principals. No automatic public grant.
resource "google_cloud_run_v2_service_iam_member" "api_transport" {
  for_each = var.api_invokers
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api[0].name
  role     = "roles/run.invoker"
  member   = each.value.member
  dynamic "condition" {
    for_each = lookup(each.value, "condition", null) == null ? [] : [each.value.condition]
    content {
      title       = condition.value.title
      expression  = condition.value.expression
      description = lookup(condition.value, "description", null)
    }
  }
}

locals {
  runtime_secret_refs = concat(
    [for env in try(var.api_definition.env, []) : { secret = env.secret, identity = "api" } if lookup(env, "secret", null) != null],
    flatten([for kind, job in var.processing_jobs : [for env in job.env : { secret = env.secret, identity = "jobs" } if lookup(env, "secret", null) != null]])
  )
  # The four processors share secrets: one state owner per secret/principal.
  runtime_secrets = { for ref in local.runtime_secret_refs : "${ref.identity}:${ref.secret}" => ref... }
}
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.runtime_secrets
  project   = var.project_id
  secret_id = each.value[0].secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.identity[each.value[0].identity].email}"
}

resource "google_cloud_run_v2_job_iam_member" "processing_invokers" {
  for_each = var.processing_invokers
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.processing[each.value.job].name
  role     = "roles/run.invoker"
  member   = each.value.member
  dynamic "condition" {
    for_each = lookup(each.value, "condition", null) == null ? [] : [each.value.condition]
    content {
      title       = condition.value.title
      expression  = condition.value.expression
      description = lookup(condition.value, "description", null)
    }
  }
}

resource "google_cloud_run_v2_job" "processing" {
  for_each            = var.processing_jobs
  project             = var.project_id
  location            = var.region
  name                = "photointel-${each.key}"
  deletion_protection = true
  template {
    task_count  = each.value.task_count
    parallelism = each.value.parallelism
    template {
      service_account = each.value.service_account
      max_retries     = each.value.max_retries
      timeout         = each.value.timeout
      containers {
        image   = each.value.image
        command = each.value.command
        args    = each.value.args
        resources { limits = each.value.limits }
        dynamic "env" {
          for_each = each.value.env
          content {
            name  = env.value.name
            value = lookup(env.value, "value", null)
            dynamic "value_source" {
              for_each = lookup(env.value, "secret", null) == null ? [] : [env.value]
              content {
                secret_key_ref {
                  secret  = value_source.value.secret
                  version = value_source.value.version
                }
              }
            }
          }
        }
      }
    }
  }
  depends_on = [google_service_account_iam_member.terraform_api, google_secret_manager_secret_iam_member.runtime]
  lifecycle { prevent_destroy = true }
}

output "api_release" {
  value = var.enable_api_service ? { image = var.api_definition.image, uri = google_cloud_run_v2_service.api[0].uri } : null
}
