#!/usr/bin/env bash
# Provision Cloudflare Access -> GCP federation for the dedicated read-only Manage SA.
# Called only by the privileged GCP bootstrap after IAM reconciliation.
set -Eeuo pipefail
CONFIG="${GCP_CONFIG_FILE:-infra/gcp/config.local.json}"
PROJECT="$(jq -er '.project_id' "$CONFIG")"
[[ "$PROJECT" == "photointel" ]] || { echo "::error::Unexpected GCP project" >&2; exit 2; }
EMAILS="$(jq -r '.extra_environment.MANAGE_ACCESS_ALLOWED_EMAILS // ""' "$CONFIG")"
if [[ -z "$EMAILS" ]]; then
  echo "[manage-wif] No Manage admin allowlist; federation setup skipped."
  exit 0
fi
command -v gcloud >/dev/null
command -v curl >/dev/null
ADMIN_LIST="$(jq -cen --argjson emails "$EMAILS" '
  $emails | if type=="array" and length>0 and length<=12
    and all(.[]; type=="string" and test("^[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}$"))
  then (map(ascii_downcase) | unique) else error("Invalid admin list") end
')" || { echo "::error::Invalid MANAGE_ACCESS_ALLOWED_EMAILS" >&2; exit 2; }
TEAM="$(jq -er '.access_team_domain' "$CONFIG")"
[[ "$TEAM" =~ ^[a-z0-9-]+\.cloudflareaccess\.com$ ]] || { echo "::error::Invalid Access team domain" >&2; exit 2; }
POOL=manage
PROVIDER=cloudflare-access
MANAGE_SA="photointel-manage@$PROJECT.iam.gserviceaccount.com"
project_num="$(gcloud projects describe "$PROJECT" --project="$PROJECT" --format='value(projectNumber)' --quiet)"
[[ "$project_num" =~ ^[0-9]{6,15}$ ]] || exit 1
AUDIENCE="//iam.googleapis.com/projects/$project_num/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
expected_audience="$(jq -r '.extra_environment.MANAGE_GCP_WIF_AUDIENCE // ""' "$CONFIG")"
if [[ -n "$expected_audience" && "$expected_audience" != "$AUDIENCE" ]]; then
  echo "::error::MANAGE_GCP_WIF_AUDIENCE does not match the dedicated Manage provider: $AUDIENCE" >&2
  exit 2
fi
# Only Cloudflare Access application public AUD is retrieved. API token never logged.
secret_ref() {
  local key="$1" name version
  name="$(jq -r --arg key "$key" '.workflow_secrets[$key].name // empty' "$CONFIG")"
  version="$(jq -r --arg key "$key" '.workflow_secrets[$key].version // empty' "$CONFIG")"
  [[ -n "$name" && "$version" =~ ^[0-9]+$ ]] || return 1
  gcloud secrets versions access "$version" --secret="$name" --project="$PROJECT" --quiet 2>/dev/null
}
cf_token="$(secret_ref CLOUDFLARE_API_TOKEN)" || { echo "::error::Cloudflare API secret unavailable to GCP bootstrap" >&2; exit 1; }
cf_account="$(secret_ref CLOUDFLARE_ACCOUNT_ID)" || { echo "::error::Cloudflare account secret unavailable to GCP bootstrap" >&2; exit 1; }
[[ "$cf_account" =~ ^[a-fA-F0-9]{32}$ && ${#cf_token} -ge 20 ]] || { echo "::error::Cloudflare credentials invalid" >&2; exit 2; }
tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --max-time 15 \
  -H "Authorization: Bearer $cf_token" \
  "https://api.cloudflare.com/client/v4/accounts/$cf_account/access/apps?per_page=100" > "$tmp/apps.json"
aud="$(jq -er '
  if .success != true then error("Cloudflare Access apps request unsuccessful") else .result end |
  [ .[] | select(.name == "photointel-manage" and
    any(.domain, (.domain == "photos-manage.migos.club"))) | .aud ] |
  if length == 1 and (.[0] | type == "string" and length>=20) then .[0]
  else error("Manage Access application unavailable or ambiguous") end
' "$tmp/apps.json")" || { echo "::error::Unable to discover the Manage Access application audience" >&2; exit 1; }
unset cf_token cf_account
# Cloudflare Access exposes RSA public signing keys at this endpoint.
curl --fail --silent --show-error --max-time 15 "https://$TEAM/cdn-cgi/access/certs" > "$tmp/certs.json"
jq -e '{keys: [.keys[] | select(.kty == "RSA" and .kid and .n and .e)]}
  | select(.keys | length > 0)' "$tmp/certs.json" > "$tmp/jwks.json" ||
  { echo "::error::Cloudflare Access RSA JWKS unavailable; federation not changed" >&2; exit 1; }
condition="assertion.email in $ADMIN_LIST"
gcloud iam workload-identity-pools describe "$POOL" --location=global --project="$PROJECT" --quiet >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location=global --project="$PROJECT" \
    --display-name="PhotoIntel Manage Access" --quiet
if gcloud iam workload-identity-pools providers describe "$PROVIDER" \
    --workload-identity-pool="$POOL" --location=global --project="$PROJECT" --quiet >/dev/null 2>&1; then
  op=update-oidc
else
  op=create-oidc
fi
gcloud iam workload-identity-pools providers "$op" "$PROVIDER" \
  --location=global --workload-identity-pool="$POOL" --project="$PROJECT" \
  --issuer-uri="https://$TEAM" --allowed-audiences="$aud" \
  --attribute-mapping="google.subject=assertion.sub,attribute.email=assertion.email" \
  --attribute-condition="$condition" --jwk-json-path="$tmp/jwks.json" --quiet
# Scoped IAM grants: an authenticated email in this *dedicated provider*, not the pool.
jq -r '.[]' <<< "$ADMIN_LIST" | while IFS= read -r email; do
  gcloud iam service-accounts add-iam-policy-binding "$MANAGE_SA" --project="$PROJECT" \
    --member="principalSet://iam.googleapis.com/projects/$project_num/locations/global/workloadIdentityPools/$POOL/attribute.email/$email" \
    --role=roles/iam.workloadIdentityUser --condition=None --format=none --quiet
done
echo "[manage-wif] Manage Access federation reconciled (read-only SA, scoped application audience and emails)."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '\n### PhotoIntel Manage WIF\n- Audience: `%s`\n- Service account: `%s`\n' "$AUDIENCE" "$MANAGE_SA" >> "$GITHUB_STEP_SUMMARY"
fi
