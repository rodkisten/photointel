# PhotoIntel → Telegram · jobs, progress and failures

PhotoIntel now sends **durable job lifecycle events** to the xtelegram sender at
POST /notifications/send. This is independent of Notify! Live Activities.
The sender is server-to-server; never put the bearer token in frontend builds.

## What gets sent

- 📥 queued, 🛠 preparing, 🔄 running, ⚠️ retrying, ✅ completed, ❌ failed, 🛑 cancelled.
- **One Telegram message per batch or standalone job**. Transitions update that
  same bubble by D1-backed `notification_key` and monotonic `JobEvent.id`.
  The notification shows live job counts and completion fraction for the batch.
- Failed/retrying job attempts update the existing batch/job bubble with technical diagnostics:
  error code, exception class, attempts, job UUID, correlation UUID, exact Sentry
  event ID and available sanitized stack frames (file/line/function).
- Each status has links for **PhotoIntel Jobs** and **GCP Logs Explorer**. Failures
  with a Sentry event also get an **exact Sentry event** button using the existing
  authenticated /v1/observability/sentry-events/{id} resolver.
- The diagnostic is formatted with Telegram **MarkdownV2** and capped below the
  Telegram 4096-character limit. The full original traceback is stored in
  Sentry and accessible via the button. Exception messages, local variables,
  signed URLs, photo metadata, tokens and credentials are never sent to Telegram.

Notifications use a separate durable event cursor and lease in PostgreSQL's
existing settings table. Initial enablement starts at the latest event to avoid
historical floods. Provider failure never marks the job as failed. A failed
delivery is retried at the next opportunity; a network timeout can result in a
duplicate, since provider delivery is at-least-once.

## Configuration (single GCP_CONFIG_ENV JSON)

On the **xtelegram-cf Cloudflare Worker**, configure its independent sender:

    wrangler secret put NOTIFICATION_API_TOKEN

Set the same random token value in the **Google Secret Manager** secret
photointel-telegram-notification-token. This secret has a separate identity from
RELAY_TOKEN and must not be committed to source control.

Add the following entries to the existing GCP_CONFIG_ENV JSON, **merging**
with the current objects, not replacing them:

    "secrets": {
      "TELEGRAM_NOTIFICATION_API_TOKEN": {
        "name": "photointel-telegram-notification-token",
        "version": "1"
      }
    },
    "extra_environment": {
      "TELEGRAM_NOTIFICATION_URL": "https://YOUR-RELAY-DOMAIN/notifications/send",
      "TELEGRAM_NOTIFICATION_CHAT_ID": "-1001234567890:73"
    }

Change the example values. Both URL and chat are nonsecret deployment settings.
A forum topic suffix (:73) is supported. For private messages, start the bot
before attempting to send to your numeric private chat ID.

The deploy renderer will set TELEGRAM_JOB_EVENTS_ENABLED=true only when the
pinned token reference and both destination settings exist. It remains false for
database migration jobs. **Do not** put TELEGRAM_JOB_EVENTS_ENABLED in
extra_environment because it is a protected generated variable.

1. Configure the Google Secret Manager secret version with the **same token**
   used by xtelegram. The API and job workers need secretAccessor permissions
   on that secret. Run the established GCP setup grant path.
2. **Deploy the updated relay FIRST**, applying its D1 migration
   `0010_editable_notifications.sql` with `npm run db:migrate:remote` and
   publishing the Worker with the current secrets. PhotoIntel requires relay
   `GET /notifications/capabilities` returning `editable-v1`, followed by
   response fields `notification_key` and `message_id` for each upsert ACK.
   The probe fails closed **before sending** if the deployed relay is older,
   protecting Telegram from duplicate messages during a rollout.
3. Apply the existing GCP deployment process to update API and job worker
   environments. No SQL migration is required for PhotoIntel.
4. Start a small legitimate job, confirm enqueued/running/completed messages
   in Telegram. Induce only a non-sensitive staging failure to verify
   Sentry/GCP links and redaction.

Local development can use:

    TELEGRAM_JOB_EVENTS_ENABLED=true
    TELEGRAM_NOTIFICATION_URL=https://YOUR-RELAY-DOMAIN/notifications/send
    TELEGRAM_NOTIFICATION_CHAT_ID=12345678
    TELEGRAM_NOTIFICATION_API_TOKEN=<secret from your local .env>

Never log the relay token, publish it as an Actions variable, or send it to the
browser. Failing relay responses are logged by **exception type only**, without
printing request headers or provider response bodies.

### Operational notes

- The notification sender is non-blocking with respect to the durable job
  outcome, though delivery is awaited for a bounded interval during the
  post-commit drain. A provider outage never changes the job state.
- For high-volume batches, every state change updates the same batch bubble.
  A still-failed job keeps the batch labeled as having errors even if another
  job has completed subsequently. Individual error metadata is kept in Sentry
  and GCP Logs, linked from the message where available.
- The GCP button searches structured Cloud Run job logs for job/correlation IDs.
  Sentry is the source of truth for complete exception events; Telegram contains
  a sanitized Markdown summary, not raw or potentially sensitive provider text.

The GitHub Actions Notify composite action also supplies the stable key
`workflow:<owner>/<repo>:<run_id>` and a sequence derived from run attempt
and step. The signed GitHub webhook uses the **same key**, so start/progress/end
and webhook events share one bubble and stale events cannot revert its state.
