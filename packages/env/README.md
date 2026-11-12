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
