// Isolated PR previews. Never proxy requests to the production Manage API.
const HOST = 'preview.manage.migos.club';
const ALIAS = 'preview-manage.migos.club';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    if (host === ALIAS) {
      url.hostname = HOST;
      return Response.redirect(url.toString(), 308);
    }
    const match = /^pr([1-9][0-9]*)\.preview\.manage\.migos\.club$/.exec(host);
    if (!match) return new Response('Choose a PR preview: pr<NUMBER>.preview.manage.migos.club', {
      status: 404, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    // A static-only Worker, never the privileged production Manage Worker.
    const target = new URL(request.url);
    target.protocol = 'https:';
    target.hostname = 'photointel-manage-pr-' + match[1] + '.' + env.WORKERS_SUBDOMAIN + '.workers.dev';
    const response = await fetch(new Request(target, request), { redirect: 'manual' });
    const headers = new Headers(response.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    return new Response(response.body, { status: response.status, headers });
  },
};
