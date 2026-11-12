# ENV ownership during Terraform adoption

`packages/env` is the shared TypeScript implementation for local parsing,
reference expansion and safe previews. Manage's client preview imports it.

## Runtime boundaries

- **Terraform** owns resource existence, IAM and non-sensitive configuration.
- **Secret Manager** owns secret payloads. Terraform can import/create secret
  containers, but must not create `google_secret_manager_secret_version`
  containing credentials.
- **Cloudflare** secrets are configured via existing secure Wrangler paths.
- **Cloud Run jobs** currently execute Python and continue to use the
  production Python parser until a differential parity test and a Node-based
  configuration build step are introduced.
- **GitHub Actions** can run the TypeScript package on Node 22, but should
  never print resolved secret values in logs.

## Migration sequence

1. Build golden fixtures for dotenv references, WF/ENV/CF aliases, compact
   and legacy secret references, JSON types, and conflicting keys.
2. Compare Python and TypeScript outputs, including error behavior.
3. Introduce a Node adapter that writes a **non-sensitive** Terraform
   variables JSON file and an independent secret-name inventory.
4. Reconcile production resources through Terraform import before apply.
5. Update deployment jobs to use the adapter while keeping the Python parser
   as rollback until parity is proven.

**Current limitations:** This PR does not switch Python jobs to TypeScript.
The new parser is a foundation, not full behavioral parity with the production
Python decoder, and the Terraform resource model is still incomplete.
