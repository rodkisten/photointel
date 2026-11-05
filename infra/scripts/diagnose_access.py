#!/usr/bin/env python3
"""Read-only Access checks. Emit status/booleans only, never tokens or responses."""
import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from infra.scripts.prepare_workflow_env import read_config, secret_value, worker_environment


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    config = read_config()
    public = worker_environment(config)
    host = public['WORKER_DOMAIN']
    opener = urllib.request.build_opener(NoRedirect)
    results = {}
    for path in ('/', '/v1/operations/status'):
        request = urllib.request.Request('https://' + host + path, headers={'Cache-Control': 'no-cache'})
        try:
            with opener.open(request, timeout=20) as response:
                status, headers = response.status, response.headers
        except urllib.error.HTTPError as error:
            status, headers = error.code, error.headers
            error.close()
        except (OSError, ValueError):
            results[path] = {'network_error': True}
            continue
        target = urlsplit(headers.get('Location', ''))
        results[path] = {'status': status,
                         'redirects_to_access': bool(target.hostname and target.hostname.endswith('.cloudflareaccess.com')),
                         'auth_stage': headers.get('X-PhotoIntel-Auth', 'not-reported')}
    token = secret_value(config, 'CLOUDFLARE_API_TOKEN')
    account = secret_value(config, 'CLOUDFLARE_ACCOUNT_ID')
    request = urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/' + account + '/access/apps?per_page=100',
                                    headers={'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            payload = json.load(response)
        matched = []
        for app in payload.get('result', []):
            domains = [app.get('domain', ''), *app.get('self_hosted_domains', [])]
            domains += [d.get('uri', '') for d in app.get('destinations', []) if isinstance(d, dict)]
            normalized = [value.removeprefix('https://').removeprefix('http://').rstrip('/')
                          for value in domains if isinstance(value, str)]
            if any(value == host or value.startswith(host + '/') for value in normalized):
                matched.append({'domain': app.get('domain'),
                                'covers_whole_hostname': host in normalized,
                                'audience_matches_api_config': app.get('aud') == config.get('access_audience'),
                                'bypass_policy_present': any(p.get('decision') == 'bypass' for p in app.get('policies', []))})
        results['access_applications'] = matched
    except urllib.error.HTTPError as error:
        results['access_api_http'] = error.code
        error.close()
    except (OSError, ValueError, TypeError):
        results['access_api_unavailable'] = True
    print('ACCESS_DIAGNOSTIC=' + json.dumps(results))
    if results.get('/', {}).get('status') == 200:
        print('::warning::Unauthenticated root request reached the app. Verify Access protects this hostname with an Allow policy, not Bypass.')
    if results.get('access_api_http') in (401, 403):
        print('::warning::Cloudflare token cannot inspect Access applications. Access: Apps and Policies Read permission is required for this diagnostic.')


if __name__ == '__main__':
    main()
