# PhotoIntel unified Google Cloud CLI transport

**One shared executor:** `infra.gcp.cloud_cli` (source: `infra/gcp/cloud_cli.py`).

The prior repository had multiple copies of Google Cloud invocation logic in
`manage.py`, `manage.mjs`, `terminal.py`, `boot_logs.py`,
`sync_startup.py`, `migrate_workflow.py`, Cloud Run diagnostics,
`prepare_workflow_env.py`, `icloud_terminal.py`, and Bash bootstrap scripts.

All infrastructure commands now use the same project-scoped transport, either
imported in Python or invoked by Bash/Node. The implementation does **not**
perform automatic interactive login, create credential files or bypass IAM.

## Cloud Shell or Termius commands

The Google Cloud account is selected by Google's own supported authentication:
existing user `gcloud auth login` or Workload Identity Federation in CI.
There is no static JSON service account key or fallback credential in this module.

```bash
# Read-only command; no GitHub Actions and no implicit project:
python3 -m infra.gcp.cloud_cli --project photointel -- auth list --format=value(account)

python3 -m infra.gcp.cloud_cli --project photointel -- \
  compute instances describe photointel-terminal \
  --zone=us-central1-a --format=json

# Intentionally *not* automatic login:
gcloud auth login --no-launch-browser
```

The wrapper appends exactly one `--project=...` and `--quiet`, detects
conflicting project flags and never runs through a shell. Successful stdout is
passed through (and must be handled privately for Secret Manager reads).
Provider stderr and sensitive command arguments are **never printed** by the
shared CLI on failure; errors use `CLOUD_CLI_ERROR PERMISSION_DENIED`,
`NOT_FOUND`, `UNAUTHENTICATED` or `PROVIDER_ERROR`.

## Python

```python
from infra.gcp.cloud_cli import run, classify

result = run(
    ["run", "services", "describe", "photointel-api",
     "--region=us-central1", "--format=json"],
    project="photointel",
    timeout=45,
)
if result.returncode:
    raise RuntimeError(classify(result.stderr).code)
```

`run` returns `subprocess.CompletedProcess`, preserving existing
business-specific preflight behavior. The shared `command` function builds
normalized arguments. `CloudCommandError` only exposes safe error categories
and allowlisted GCP permission names, never raw stderr.

Use `text=False` for sensitive binary stdin/stdout and never log
`result.stdout` from Secret Manager.

## Bash

```bash
PROJECT=photointel
gcp() {
  python3 -m infra.gcp.cloud_cli "--project=$PROJECT" -- "$@"
}
gcp run services describe photointel-api --region=us-central1 --format=json
```

`infra/gcp/bootstrap.sh` and `bootstrap_manage_wif.sh` invoke this interface.
A missing WIF resource is only created if the shared CLI explicitly classifies
the existence check as `NOT_FOUND`. Permission denied does not count as absent.

## Node / Cloud Build

`infra/gcp/manage.mjs` uses its existing `runChecked` / `runProbe` helpers,
but delegates GCP commands to the shared Python bridge. `cloudbuild.yaml`
and the GitHub `gcp-deploy.yml` maintenance wakeup step also use the bridge.
Cloud Build YAMLs that call `manage.py` or `bootstrap.sh` inherit it.

## Explicit boundaries

* This module centralizes **gcloud CLI invocation**, not provider business
  rules, resource authorization or billing decisions.
* The Manage **Cloudflare Worker** does not have a Linux process or Python
  runtime; its `providers.ts` authenticates with GCP's WIF/REST APIs. That is
  a separate, serverless transport and should not be replaced with a fake
  `gcloud` shell command.
* The iCloud setup's SDK installer must still locate or download the official
  `gcloud` binary before this executor can run. Its actual Google Cloud
  requests use the shared transport.
* The Dockerfile's `gcloud version` is a container smoke check, not a GCP API
  request; it deliberately continues testing the actual installed binary.
* Versioned scripts still require their own explicit `--apply` and
  `--authorize-charges` flags; this module never elevates privileges or
  starts billable resources on its own.
* Changing the CLI does not require redeploying the API application itself.
  It affects local/CI administration tools and Cloud Build source steps.

## Offline checks

```bash
python3 -m unittest discover -s infra/gcp/tests -p 'test_cloud_cli.py' -v
python3 -m unittest discover -s infra/terminal -p 'test_terminal.py' -v
bash infra/gcp/tests/test-bootstrap.sh
node --check infra/gcp/manage.mjs
bash -n infra/gcp/bootstrap.sh infra/gcp/bootstrap_manage_wif.sh
```

The unit tests mock subprocess. They do not contact GCP or incur costs.

## Installed entrypoints

Install the project from its checkout without pulling its optional API/ML
runtime dependencies when only administration is needed:

```bash
python3 -m pip install --no-deps -e .
photointel-gcloud --project photointel -- run services list --enabled
photointel-gcp doctor --config infra/gcp/config.local.json
photointel-vm-sync
```

The project declares CLI entrypoints in pyproject.toml. For operations that
need repository files (deploy, VM startup sync, Secret Manager references),
run from your checkout or set PHOTOINTEL_REPO_ROOT=/absolute/path/to/photointel.
The pure photointel-gcloud transport works independently of a checkout.
The dotenv parser lives at infra.gcp.gcp_env, not a hyphenated Python file.

## Root deployment CLI

`deploy.sh` uses the shared `python3 -m infra.gcp.cloud_cli --project photointel -- ...`
bridge for GCP operations and imports `infra.*` modules for Cloudflare/Manage
operations. It does not alter the globally active GCP project.

```bash
bash deploy.sh help
bash deploy.sh doctor
bash deploy.sh plan
bash deploy.sh all --yes  # review before production changes
```

Native `gcloud auth login --no-launch-browser` is only used for interactive
OAuth, which cannot run through the captured-output bridge.
