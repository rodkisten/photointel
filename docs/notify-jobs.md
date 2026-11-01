# Notify! for PhotoIntel API jobs

GitHub Actions uses `.github/actions/notify`; the Cloud Run API and workers use
`apps/api/src/photointel/services/job_notify.py`.

## What arrives on the iPhone

- One **Live Activity per batch** (or per standalone job), named after the actual
  processing activity: e.g. `PhotoIntel · Importação iCloud`.
- Events: **Enfileirado**, **Processando**, **Tentando novamente**, **Concluído**,
  **Falhou** or **Cancelado**.
- Real progress as finished jobs / total jobs. The number of segments is capped
  at 20, without losing the true fraction shown in the label.
- Success/failure ends the same activity. Individual photos do **not** generate
  separate push notifications.
- No image filenames, private metadata, job error bodies or credentials are sent.

## One-time Secret Manager setup

The `NOTIFY_DEVICE_ID` and `NOTIFY_TOKEN` used by GitHub Actions are **not**
automatically available to the API.

1. Create two **distinct secrets** in Google Cloud Secret Manager, using your
   existing Notify! device ID and token. For example, `photointel-notify-device-id`
   and `photointel-notify-token`.
2. Add pinned references under `secrets` in the existing `GCP_CONFIG_ENV` JSON
   variable, without including secret values:

```json
{
  "NOTIFY_DEVICE_ID": {"name": "photointel-notify-device-id", "version": "1"},
  "NOTIFY_TOKEN": {"name": "photointel-notify-token", "version": "1"}
}
```

   The snippet contains **only the two new entries** for the existing `secrets`
   object. Do not replace the full deployment configuration with it.
3. Run the operator-approved **Setup GCP apply** to grant the API/worker service
   accounts `secretmanager.secretAccessor` on these references.
4. Run the approved **Deploy release** process after checking database readiness.

The deployment renderer enables `NOTIFY_JOB_EVENTS_ENABLED=true` only when
both references exist. Without them, no outbound Notify! calls are made.
A configured secret reference with a missing version causes the guarded deploy
to fail, instead of printing or exposing a secret.

## Delivery guarantees

Job events and per-batch activity IDs are stored in PostgreSQL. A short lease
ensures one notification drainer processes events at a time; callbacks run after
the job transaction commits, outside DB locks. Failures are best-effort and never
alter job results. The cursor is retried, but external delivery cannot guarantee
exactly once if a process crashes after the provider accepts an update and before
the activity ID is persisted. Automatic calls are bounded. On initial activation,
a small recent-event window is scanned rather than sending the entire backlog.
