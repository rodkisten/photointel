mock_provider "cloudflare" {}
run "metadata_only_adoption" {
  command = plan
  assert {
    condition     = cloudflare_workers_custom_domain.domains["photos.migos.club"].service == "photointel"
    error_message = "The frontend custom domain must keep its existing Worker."
  }
  assert {
    condition     = cloudflare_d1_database.databases["photointel-manage"].name == "photointel-manage"
    error_message = "The existing management database must be retained."
  }
  assert {
    condition     = cloudflare_zero_trust_access_policy.policies["policy"].decision == "allow"
    error_message = "Adoption may not replace the Access rule with a bypass."
  }
}
