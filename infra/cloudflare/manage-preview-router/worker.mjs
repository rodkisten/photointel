// Public landing/alias only. Individual PR Workers have exact routes and no workers.dev exposure.
const HOST = 'preview.manage.migos.club';
const ALIAS = 'preview-manage.migos.club';
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    if (host === ALIAS) {
      url.hostname = HOST;
      return Response.redirect(url.toString(), 308);
    }
    if (host !== HOST) {
      return new Response('Preview not deployed for this PR.', { status: 404, headers: BASE_HEADERS });
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', { status: 405, headers: BASE_HEADERS });
    }
    // Resolve the most recently updated open PR from the public GitHub API.
    // A missing or private API response never redirects to a guessed PR.
    try {
      const api = await fetch('https://api.github.com/repos/rodkisten/photointel/pulls?state=open&sort=updated&direction=desc&per_page=30', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'photointel-preview-router' },
        cf: { cacheTtl: 30, cacheEverything: true },
      });
      if (api.ok) {
        const prs = await api.json();
        const pr = prs.find(item => item?.number && item?.head?.repo?.full_name === 'rodkisten/photointel');
        if (pr) {
          url.hostname = 'pr' + pr.number + '.' + HOST;
          return Response.redirect(url.toString(), 307);
        }
      }
    } catch { /* Show actionable landing instead of an unhandled exception. */ }
    return new Response('No available PR preview. Open https://github.com/rodkisten/photointel/pulls to choose a PR.', {
      status: 503, headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
