terraform {
  required_version = ">= 1.17.2, < 1.18.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
  backend "gcs" {}
}
provider "google" {
  project = var.project_id
  region  = var.region
}
provider "cloudflare" {}
