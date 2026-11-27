# Historical secret scan triage

Status: open. Do not disable full-history scanning or approve broad path/rule exclusions.

| Finding | Evidence | Disposition |
| --- | --- | --- |
| JWT in apps/manage/src/auth.test.ts, d89d930, line 46 | Historical source is a redaction unit test | Candidate fixture; verify token provenance before exact fingerprint exception |
| Generic key in tests/test_infra_safety.py, 66580ac, line 48 | Historical source is a diagnostics redaction fixture | Candidate fixture; verify literal provenance before exception |
| GCP API key in apps/web/public/fcm.js, 0e42b92, line 17 | Historical source is Firebase client configuration for photointel | Verify API and application restrictions in Google Cloud; public client configuration alone is not proof of safe restrictions |
| Remaining historical matches | Not individually inspected | Open |

## Closure requirements

- Inspect each historical match without copying credential values into tickets or logs.
- Confirm whether it is synthetic, public client configuration with appropriate restrictions, or a real secret.
- Revoke or rotate exposed real credentials and review usage.
- Record evidence and exact Gitleaks fingerprint for any approved exception; no wildcard exceptions.
- Keep the full-history scan blocking until disposition is approved.

No credential rotation or exception was performed by this change.
