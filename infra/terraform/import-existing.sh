#!/usr/bin/env bash
# Import existing production resources only. No terraform apply, no creation.
set -Eeuo pipefail
project=photointel
region=us-central1
import_if_missing() {
  local address="$1" id="$2"
  if terraform state show "$address" >/dev/null 2>&1; then
    printf 'Already imported: %s\n' "$address"
    return
  fi
  terraform import -input=false -lock-timeout=5m "$address" "$id"
}
# All accounts are pre-existing; verify each before import to avoid surprises.
for account in api jobs migrate scheduler builder deployer bootstrap media manage; do
  address="google_service_account.identity[\"$account\"]"
  import_if_missing "$address" "projects/$project/serviceAccounts/photointel-$account@$project.iam.gserviceaccount.com"
done
import_if_missing google_artifact_registry_repository.docker "projects/$project/locations/$region/repositories/photointel"
import_if_missing google_storage_bucket.build_source "$project-photointel-build-source"
echo 'Core resources imported. Review terraform plan for drift; IAM and optional resources require separate review.'
