# Media bootstrap CLI

A TypeScript command-line interface with full-width command display, shell-token
colors and one progress spinner per executed step. Supports narrow mobile terminals.

```sh
cd services/media/bootstrap
npm install
npm run plan
npm run verify
npm run apply
```

- `plan`: checks existing GCP access and Artifact Registry, displays secret
  creation commands without applying them.
- `verify`: checks that the two signing secrets already exist.
- `apply`: requires a real interactive terminal and explicit typed approval,
  creates only missing signing secrets using cryptographic randomness, and
  preserves existing secrets. Values are passed through stdin, not CLI arguments.

No billing operations or Cloudflare token creation. Cloudflare R2 API tokens,
Worker secrets and IAM bindings remain a separate integration phase. Do not
interpret successful secret creation as a deployed or working Media Engine.
