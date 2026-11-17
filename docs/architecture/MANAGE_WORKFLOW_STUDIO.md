# Workflow Studio · PhotoIntel Manage

> Status: architecture baseline. Implementation checklist is deliberately unchecked until code is delivered.

## Goal

A persistent visual automation editor at `/workflows`, built with `@xyflow/react`, visually consistent with the existing Manage carbon palette and UI primitives. Compose existing GitHub Actions, Cloudflare, GCP and Modal operations with conditional branches, retries, parallel paths, schedules and notifications. Never trigger a deployment merely by opening or editing a graph.

## Existing integration points (verified on main)

- `apps/manage/src/pages/DeployTriggers.tsx` exposes existing deploy rules, run history and manual Cloudflare deploy confirmation.
- `apps/manage/src/worker.ts` already routes signed GitHub events at `/hooks/github`, Cloud Build callbacks at `/hooks/cloud-build`, and scheduled ticks through `deploy-router/service`.
- `apps/manage/src/auth.ts` exposes `DEPLOY_DB` (D1); `apps/manage/src/api.ts` handles authenticated API operations.
- `apps/manage/src/main.tsx` uses React 19, TanStack Router and TanStack Query. Zustand is already a dependency.
- `apps/manage/package.json` contains the existing UI stack; add `@xyflow/react` and a layout engine with matching lockfile updates during implementation.

## Architecture

Keep the editor's graph representation separate from the execution model. React Flow is presentation-only. Persist versioned, schema-validated graphs in the existing D1 binding `DEPLOY_DB` with migrations. Store workflow definitions, immutable published revisions, execution instances, node attempts, transitions, deduplication keys, and webhook deliveries. Never persist credentials in node JSON.

### Editor

- Dark, compact Vercel/Linear-inspired surfaces; use existing Manage tokens, components and typography rather than duplicating a design system.
- Custom nodes: manual/webhook/cron trigger, GitHub Actions dispatch, Cloudflare deploy, GCP build, Modal job, condition/switch, delay, retry, parallel/join, HTTP request, notification, subworkflow.
- Typed input/output handles; validate incompatible edges, unreachable nodes and cycles (except explicit bounded retry nodes).
- Autosave draft with optimistic concurrency and clear unsaved/error states. Publish immutable revision, duplicate, rollback, export/import JSON.
- Mobile Safari: touch-friendly handles, tap-to-connect, pinch zoom, bottom configuration drawer and fit-view control.
- Execution overlay: pending/running/success/failure/cancelled/skipped, attempts, logs, timestamps and provider links.
- Add route and navigation entry to existing TanStack Router, plus interactive playground and documentation.

### Backend / webhook reuse

Reuse the signed GitHub webhook and Cloud Build callback infrastructure. Do not replace HMAC verification, Cloudflare Access checks, CSRF origin checks or existing deploy-router behavior. Extend event normalization to a common envelope:

```ts
type WorkflowEvent = {
  id: string;
  source: 'github' | 'cloudflare' | 'gcp' | 'modal' | 'manual' | 'cron';
  kind: string;
  occurredAt: string;
  correlationId: string;
  workflowRunId?: string;
  providerRunId?: string;
  status?: 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'timed_out';
  outputs?: Record<string, unknown>;
};
```

- Deduplicate provider events by event ID and provider run/attempt; accept out-of-order callbacks without regressing terminal state.
- GitHub dispatch returns before completion. Poll or receive a verified completion webhook, correlate the correct run and attempt, and only then traverse conditional edges.
- Use a durable scheduled/queued execution loop with lease, retry/backoff, dead-letter state and concurrency limits. Never depend on an in-memory timer or browser session.
- Condition nodes read allowlisted structured outputs; do not evaluate arbitrary JavaScript or user-provided expressions with `eval`.
- Explicit deployment confirmation, dry-run, RBAC/Access enforcement, audit log, secret redaction, idempotency and environment guardrails.
- Cron timezone defaults to `America/Sao_Paulo`; document DST and missed-run policy.
- Retain existing `/triggers` UI and endpoints; Studio orchestrates through existing provider adapters, not duplicate provider implementations.

### Suggested API

`GET/POST /api/workflow-studio/flows`; `GET/PUT/DELETE /api/workflow-studio/flows/:id`; `POST /api/workflow-studio/flows/:id/publish`; `POST /api/workflow-studio/flows/:id/runs`; `GET /api/workflow-studio/runs/:id`; `POST /api/workflow-studio/runs/:id/cancel`; `GET /api/workflow-studio/catalog`. Apply the existing authentication and request validation conventions.

## Delivery checklist

- [ ] Add React Flow dependency and lockfile; create route, nav item and editor shell.
- [ ] Implement custom nodes, connection validation, auto-layout and mobile drawer.
- [ ] Add D1 migrations, CRUD API, draft autosave and immutable published revisions.
- [ ] Expose real GitHub workflow catalog and dispatch adapter.
- [ ] Normalize signed webhook events, correlate completion and persist node attempts.
- [ ] Implement durable orchestrator, conditional edges, retry, parallel/join and cancellation.
- [ ] Add Cloudflare, GCP and Modal adapters using existing deployment plumbing.
- [ ] Add cron schedules, timezone handling, observability and notification nodes.
- [ ] Add live execution history, dry-run, safety confirmations and access controls.
- [ ] Document usage and add interactive playground.
- [ ] Verify typecheck/build, inspect CI, and resolve branch conflicts before merge.

## Contribution conventions

One cohesive commit per functional work block rather than one per file. Keep this checklist updated as implementation progresses. No production deployment from this PR without explicit confirmation.
