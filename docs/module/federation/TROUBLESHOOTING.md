# Federation smoke and failure diagnosis

Implemented local smoke, not production validation. Build outputs must exist in both checkouts.

1. In RodSandbox: `pnpm build:browser`, then `MODULE_ORIGIN=http://localhost:4173 pnpm build:module`.
2. Serve that `dist` using `pnpm exec vite preview --host 0.0.0.0 --port 4173 --strictPort --cors`.
3. In Manage: `npm exec vite build -- --mode federation-smoke`, then `npm exec vite preview -- --mode federation-smoke --host 0.0.0.0 --port 3000 --strictPort`.
4. Run `CHROMIUM_EXECUTABLE=/usr/bin/chromium node scripts/smoke-federation.mjs` from Manage, or omit that variable to use Playwright's installed Chromium. The script mocks only host identity/catalog APIs; it loads real remote assets and checks editor, compilation, isolated previews, CSS, Radix portal, sizing and worker unmount. The explicit smoke server mode applies the Worker CSP template using the fixed loopback artifact origin. Never publish smoke-mode builds.

A manifest error may be HTTP/auth/MIME, incompatible contract, untrusted origin or SHA mismatch. Read the diagnostic ID and error in `/modules`; standalone remains available. Cloudflare Access HTML is not a JavaScript/JSON response. Do not add arbitrary origins to bypass the error.

Version changes require a reload. A rollback candidate also requires the old immutable artifact to remain available. The CI archive can restore an older release; its deployed retention path still needs verification.

A Worker error with an empty message can be CSP. `worker-src` must include both the blob bootstrap and reviewed artifact path: module worker imports can be checked against the worker directive. WASM requires `wasm-unsafe-eval`, not unrestricted JavaScript `unsafe-eval`.

WebKit did not launch on this machine because GTK4, Graphene, Harfbuzz ICU, Manette, Hyphen and GLES libraries are missing. Chromium mobile viewport checks are not a substitute for an actual iPhone Safari session.

Live paired preview: open https://pr-262-photointel-manage.kisten.workers.dev/modules, select the preview channel and enable Sandbox, then open it in Manage. This native origin blocks production APIs and uses synthetic identity. The production host never offers this PR channel. The friendly short URL returned 503 during validation; use the verified native URL. The paired preview and independent rollback passed Chromium browser smoke without mocked host/remote APIs.
