# Fix the PhotoIntel VM startup from the repository

`infra/terminal/startup.sh` is the source of truth for VM startup metadata.
Never edit it directly inside the ephemeral SSH Docker container. The VM
uses `startup-script` metadata, not the working-tree file, during boot.

## One-time manual sync without GitHub Actions minutes

Use the **Google Cloud Shell**, NOT the `rod` shell that SSH forwards into
the Docker container. Cloud Shell requires an authenticated Google identity
with `compute.instances.get` and `compute.instances.setMetadata` permissions.

```bash
gcloud config set project photointel
gh auth status || gh auth login --web
gh repo clone rodkisten/photointel -- --depth 1
cd photointel

# Verify shell syntax and compare SHA-256 with the existing VM metadata:
bash -n infra/terminal/startup.sh
python3 -m infra.terminal.sync_startup

# Metadata-only update, idempotent. Does NOT restart VM or change disk/config:
python3 -m infra.terminal.sync_startup --apply

# Recheck: should report Already in sync:
python3 -m infra.terminal.sync_startup
```

If `photointel` already exists in Cloud Shell, run `git -C photointel
pull --ff-only` instead of cloning again. Changes in a feature branch must
first be merged to `main` before running `sync_startup.py` from `main`.

`sync_startup.py` refuses a VM without correct labels, size or
`terminal-config`, and writes a restricted-permission backup of the old
startup script to `~/.local/state/photointel-terminal/startup-backups`.

## Activate safely

The updated metadata executes on the **next GCE startup**, not immediately.
Save running work and disconnect the SSH session before stopping/starting:

```bash
gcloud compute instances stop photointel-terminal --zone=us-central1-a --project=photointel --quiet
gcloud compute instances start photointel-terminal --zone=us-central1-a --project=photointel --quiet

# Follow sanitized startup stages, including errors:
python3 -m infra.terminal.boot_logs --name photointel-terminal --zone us-central1-a --timeout-seconds 720
```

Alternatively use the Compute Engine Console stop/start buttons. The VM's
`/var/lib/terminal/home` bind mount is on its persistent boot disk. The
metadata-only sync does not recreate the VM, alter `terminal-config`,
replace the Docker image or modify the home mount. Before stopping, save
running edits and check which files are in the persistent home.

## What was fixed

- A fresh Debian 12 VM can have no `jq`; bootstrap it before reading JSON
  `max_minutes` and preserve public APT key readability.
- Validate the configured timeout (15–720 minutes). GCE
  `max-run-duration` + STOP remains an independent hard stop.
- Do not claim SSH ready before verifying Tailscale IP, the running Docker
  container and required CLI tools.
- Remove temporary OAuth credentials before emitting `Terminal ready`.
  Cleanup remains safe and idempotent even after earlier failure.
- Metadata deployment remains a standalone step. If your terminal image itself
  lacks tools, rebuild it separately using `infra/terminal/terminal.py build`
  in an environment with Docker and the right Artifact Registry credentials.

Do not re-run the full `provision` action just to update startup metadata: the
existing provisioner **stops and restarts** the VM. `sync_startup.py` is the
low-risk alternative and does not use GitHub Actions.
