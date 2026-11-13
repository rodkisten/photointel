terraform {
  required_version = ">= 1.17.2, < 1.18.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.29.0"
    }
  }
  backend "gcs" {}
}
provider "cloudflare" {}

# Preparation generates resources using this pinned provider's actual schema.
# No Workers script/version resource is generated: Wrangler owns code/bindings.
variable "cf_inventory" {
  type        = any
  description = "Adopted PhotoIntel metadata; never credentials or Worker secret payloads."
}
output "cloudflare_inventory" {
  value = var.cf_inventory
}
