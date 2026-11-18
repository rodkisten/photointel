# 🔀 Manage short preview links

- `https://manage.migos.club/<PR>/path` redirects to the latest native Wrangler preview URL stored in Cloudflare KV.
- `https://manage.migos.club/path` redirects to the existing main application at `photos-manage.migos.club/path`.
- The **entire** `manage.migos.club` hostname must be protected by Cloudflare Access. Access cookies do **not** transfer to the workers.dev destination; protect the preview origin separately.
- KV namespace: `photointel-manage-preview-links`. Key format: `pr:<number>`, value: verified HTTPS native preview URL.
- On a successful Wrangler preview publish, CI updates the key. On PR close, CI deletes it. No public user input can change destinations.
- This is a redirect, not a proxy: browser address changes to the Cloudflare preview URL.
- Deployment of this shortlinks Worker requires a separate, explicitly authorized Wrangler deployment; do not overwrite `photointel-manage`.
