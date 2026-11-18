/** Cloudflare Access protects manage.migos.club before this Worker runs. */
const PREVIEW_HOST = /^(?:[a-z0-9-]+\.)+workers\.dev$/i;
const PR_PATH = /^\/([1-9][0-9]{0,8})(\/.*)?$/;

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.hostname !== 'manage.migos.club') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const match = PR_PATH.exec(incoming.pathname);
    if (!match) {
      // The canonical main application remains the production Manage Worker.
      const destination = new URL(incoming.pathname + incoming.search + incoming.hash, 'https://photos-manage.migos.club');
      return Response.redirect(destination.href, 302);
    }
    const preview = await env.PREVIEW_LINKS.get('pr:' + match[1]);
    if (!preview) return new Response('Preview unavailable for PR #' + match[1], {
      status: 404, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
    let target;
    try { target = new URL(preview); } catch { return new Response('Invalid preview mapping', { status: 502 }); }
    if (target.protocol !== 'https:' || !PREVIEW_HOST.test(target.hostname) || target.username || target.password || target.port || target.search || target.hash)
      return new Response('Invalid preview origin', { status: 502 });
    target.pathname = (target.pathname.replace(/\/$/, '') + (match[2] || '/')).replace(/\/+/g, '/');
    target.search = incoming.search;
    return new Response(null, { status: 302, headers: {
      Location: target.href, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex',
    }});
  },
};
