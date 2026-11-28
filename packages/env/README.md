# @photointel/env

Pure TypeScript parser for PhotoIntel configuration. Accepts dotenv or a flat
JSON map, expands local references, classifies `WF__`, `ENV__`, `CF__`,
`SECRET__`, `WORKFLOW_SECRET__` and `secret://` entries. It **never**
fetches secrets, mutates environment variables, or writes Terraform state.

Import from `@photointel/env` in Node/Worker projects that bundle TypeScript.
Python Cloud Run jobs still use `infra/gcp/gcp_env.py` until parity fixtures
are complete; do not replace that production parser without differential tests.

Terraform should consume only public configuration and Secret Manager *names*
and *versions*, not secret payloads. Never pass credentials via `TF_VAR_*`
or plaintext `.tfvars`; Terraform state may retain input values.

## Local secret export (Node 24.2+)

From repository root: `npm --prefix packages/env run pull -- --output .env.resolved`. Requires authenticated gh and gcloud with access to referenced versions. Add `--all` for workflow and Cloudflare bindings. Output is private (0600), exclusively created, and never printed. No remote writes. Do not commit the output. Existing output is preserved; choose a fresh path for another export. Runtime config bindings are exported, not the implicit Cloud Run defaults.
