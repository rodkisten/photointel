# 🔀 Manage short preview links

- `https://manage.migos.club/<PR>/path` redirects to the latest native Wrangler preview URL stored in Cloudflare KV.
- `https://manage.migos.club/path` redirects to the existing main application at `photos-manage.migos.club/path`.
- `POST https://manage.migos.club/error/capture` proxies bounded public userscript diagnostics to the Manage Worker on `photos-hooks.migos.club`; the exact `/error/capture` path needs a path-scoped Cloudflare Access bypass so browser runtime reports can reach it. Keep the remainder of the hostname behind Access. Access cookies do **not** transfer to the workers.dev destination; protect the preview origin separately.
- KV namespace: `photointel-manage-preview-links`. Key format: `pr:<number>`, value: verified HTTPS native preview URL.
- On a successful Wrangler preview publish, CI updates the key. On PR close, CI deletes it. No public user input can change destinations.
- Preview links are redirects, not proxies; only the diagnostic capture endpoint is proxied.
- Deployment of this shortlinks Worker requires a separate, explicitly authorized Wrangler deployment; do not overwrite `photointel-manage`.
