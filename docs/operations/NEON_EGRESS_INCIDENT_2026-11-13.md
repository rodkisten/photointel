# Neon egress incident · 2026-11-13

## Verified account evidence

- Neon project: `sweet-river-27808583`, region `aws-us-east-2`, Free plan, default `production` branch.
- Current billing period started 2026-11-01T00:00:00Z.
- Neon project API: `data_transfer_bytes=5848466811` (about 5.85 decimal GB), `compute_time_seconds=63996` (17.78 CU-h), `active_time_seconds=242764`.
- One read-write endpoint `ep-proud-shadow-b4pm6cz3`, suspended since 2026-11-12T13:28:47Z. `suspend_timeout_seconds=0` means the Free plan's default five-minute auto-suspend, **not** disabled suspension.
- Live SQL statistics via Neon `inspect_database calls/outliers` were **unavailable**: HTTP 402 `Your account or project has exceeded the quota`. Therefore **we cannot attribute the 5.85 GB to any specific query or job yet**. Do not infer SQL top talkers or run a production workload merely to test.

## Confirmed code-level issue fixed in this PR

The scheduled GitHub Actions `gcp-deploy.yml` watchdog ran at minute 23 **every hour**. When the Cloud Scheduler worker was missing or paused, it explicitly launched `photointel-maintenance`, contradicting the intended paused-by-default deployment strategy. The workflow is no longer scheduled; deliberate maintenance through Cloud Scheduler remains available. This is a verified **potential periodic database wakeup**, not proven to be the source of the transfer spike. Existing manual deployment inputs are unchanged.

## Follow-up checks once quota allows SQL reads

1. Compare Neon project/branch transfer by day using the dashboard or the consumption API when available on the plan. Correlate spikes with Google Cloud Run Job executions, Cloud Scheduler attempts, GitHub Actions, and Cloudflare requests. Do not log credentials or personal media metadata.
2. Inspect `pg_stat_statements` (if installed) by `calls`, `rows`, total time; statistics reset after compute sleeps, so capture only when representative traffic returns.
3. Audit five egress patterns: unused columns/large JSONB, unbounded pages, repeated static lookups, aggregation outside SQL, and duplicate parent data from joins. Optimize individually with response-shape contract tests.
4. Confirm GCP scheduler jobs actually paused or intentionally enabled, and check whether any other CI cron, external health check, or job is waking the database.
5. Check application runtime uses `DATABASE_POOL_MODE=transaction` with the Neon `-pooler` hostname and direct URLs only for migrations.
6. Record baseline and follow-up *actual* Neon transfer metrics after deploying fixes; do not claim a percentage reduction before measurement.

## Suspension and scheduling

Free plan: Neon compute automatically sleeps after five idle minutes. The compute is **already asleep**; there is no need to suspend it again. Manual suspension drops connections, but the next client connection can wake it. To enforce quiet hours, pause the *sources* (Cloud Scheduler and maintenance jobs, external polling) as well as the compute. Never delete the branch, database, or project for cost mitigation.

## Validation

- Diff-only CI-safe change to GitHub workflow event trigger and watchdog guard. Review GitHub Actions checks on this PR before merging.
- Neon SQL-level query diagnosis and before/after measurement **blocked by quota HTTP 402**.
