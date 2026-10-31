#!/usr/bin/env python3
"""Reconcile PhotoIntel Cloudflare resources with the official API and Wrangler.

plan inspects without mutation; apply reconciles only configured PhotoIntel
resources. Credentials are resolved through the existing GCP secret references.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANAGED_POLICY = 'photointel-allowed-emails'


class SetupError(RuntimeError):
    pass


class Cloudflare:
    def __init__(self, account, token):
        if not re.fullmatch(r'[a-fA-F0-9]{32}', account):
            raise SetupError('Invalid Cloudflare account ID')
        self.account = account
        self.token = token

    def call(self, method, path, body=None, missing=False):
        if not path.startswith('/accounts/' + self.account + '/'):
            raise SetupError('Request outside configured account')
        request = urllib.request.Request('https://api.cloudflare.com/client/v4' + path,
                    data=json.dumps(body).encode() if body is not None else None,
                    headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'},
                    method=method)
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            if status == 404 and missing:
                return None
            hint = (' Check token permissions: Access Apps and Policies Edit, Access Identity Providers Edit, '
                    'Workers Scripts/Routes Edit and R2 Storage Edit for this account.') if status in (401, 403) else ''
            raise SetupError(f'Cloudflare {method} {path.split("?")[0]} failed: HTTP {status}.' + hint) from None
        except (OSError, ValueError):
            raise SetupError('Cloudflare API unavailable or invalid response') from None
        if payload.get('success') is not True:
            codes = [x.get('code') for x in payload.get('errors', []) if isinstance(x, dict)]
            raise SetupError('Cloudflare API rejected request; error codes: ' + str(codes))
        return payload

    def get(self, path, missing=False):
        result = self.call('GET', path, missing=missing)
        return None if result is None else result['result']

    def pages(self, path):
        items, page = [], 1
        while True:
            payload = self.call('GET', path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
            result = payload['result']
            if not isinstance(result, list):
                raise SetupError('Expected a paginated resource list')
            items.extend(result)
            total = payload.get('result_info', {}).get('total_pages')
            if (total is not None and page >= total) or (total is None and len(result) < 100):
                return items
            page += 1
            if page > 100:
                raise SetupError('Resource inventory exceeds bounded pagination')

    def write(self, method, path, body):
        return self.call(method, path, body)['result']

    @property
    def base(self):
        return '/accounts/' + self.account


def client(config):
    from prepare_workflow_env import secret_value
    return Cloudflare(secret_value(config, 'CLOUDFLARE_ACCOUNT_ID'),
                      secret_value(config, 'CLOUDFLARE_API_TOKEN'))


def desired(config):
    origin = urllib.parse.urlsplit(config.get('frontend_origin', ''))
    if origin.scheme != 'https' or not origin.hostname or origin.path not in ('', '/') or origin.port or origin.username or origin.password or origin.query or origin.fragment:
        raise SetupError('FRONTEND_ORIGIN must be an HTTPS origin')
    host = origin.hostname
    if not re.fullmatch(r'[a-z0-9.-]+', host):
        raise SetupError('Invalid hostname')
    emails = config.get('access_allowed_emails', [])
    if not isinstance(emails, list) or not emails or any(not isinstance(e, str) or not re.fullmatch(r'[^\s@]+@[^\s@]+', e) for e in emails):
        raise SetupError('ACCESS_ALLOWED_EMAILS must be an explicit nonempty email allowlist')
    team = config.get('access_team_domain', '')
    if not re.fullmatch(r'[a-z0-9-]+\.cloudflareaccess\.com', team):
        raise SetupError('Invalid Access team domain')
    bucket = config.get('storage_bucket', '')
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket):
        raise SetupError('Invalid R2 bucket')
    return {'host': host, 'emails': sorted(set(e.casefold() for e in emails)), 'team': team, 'bucket': bucket}


def domains(app):
    values = [app.get('domain', ''), *app.get('self_hosted_domains', [])]
    values += [d.get('uri', '') for d in app.get('destinations', []) if isinstance(d, dict) and d.get('type') == 'public']
    return set(v.removeprefix('https://').removeprefix('http://').rstrip('/') for v in values if isinstance(v, str) and v)


def select_app(apps, name, hosts, audience=None):
    named = [a for a in apps if a.get('name') == name]
    matched = [a for a in apps if domains(a).intersection(hosts)]
    by_aud = [a for a in apps if audience and a.get('aud') == audience]
    # Prefer the app protecting our exact configured audience, but never adopt
    # unrelated hosts just because someone copied an audience from another app.
    candidates = by_aud if by_aud and (by_aud[0] in named or by_aud[0] in matched) else named or matched
    if len(candidates) > 1:
        raise SetupError('Multiple Access applications match ' + name + '; refusing ambiguous adoption')
    app = candidates[0] if candidates else None
    if app and (app.get('type') != 'self_hosted' or not domains(app).issubset(set(hosts))):
        raise SetupError('Existing ' + name + ' includes unrelated domains/paths; refusing to replace it')
    if any(a is not app for a in matched):
        raise SetupError('Overlapping Access applications protect a managed hostname')
    return app


def policy(emails):
    return {'name': MANAGED_POLICY, 'decision': 'allow', 'precedence': 1,
            'include': [{'email': {'email': email}} for email in emails], 'exclude': [], 'require': []}


def app_body(existing, name, hosts, policies, idps=None):
    # Preserve supported Access settings; never copy read-only response fields.
    fields = ('session_duration', 'http_only_cookie_attribute', 'same_site_cookie_attribute',
              'app_launcher_visible', 'custom_deny_message', 'custom_deny_url', 'custom_logo',
              'allowed_idps', 'auto_redirect_to_identity', 'enable_binding_cookie',
              'options_preflight_bypass', 'cors_headers', 'skip_interstitial',
              'service_auth_401_redirect', 'allow_authenticate_via_warp')
    body = {k: copy.deepcopy(existing[k]) for k in fields if existing and k in existing}
    body.update({'name': name, 'type': 'self_hosted', 'domain': hosts[0],
                 'destinations': [{'type': 'public', 'uri': host} for host in hosts],
                 'session_duration': body.get('session_duration', '24h'), 'policies': policies})
    if idps is not None:
        # Reuse configured IdPs and allow the existing/created OTP provider.
        body['allowed_idps'] = sorted(set(body.get('allowed_idps', []) + idps))
        body['auto_redirect_to_identity'] = False
    return body


def reconcile_app(api, apps, name, hosts, audience, policies, apply, idps=None):
    existing = select_app(apps, name, hosts, audience)
    if existing:
        existing = api.get(api.base + '/access/apps/' + existing['id'])
        current_policies = api.pages(api.base + '/access/apps/' + existing['id'] + '/policies')
        unmanaged = [p for p in current_policies if p.get('name') not in {p['name'] for p in policies}]
        if unmanaged:
            # Applying this declarative configuration deliberately replaces access
            # grants ONLY on the managed PhotoIntel application, preserving no Bypass.
            print(f'Reconcile {name}: replace {len(unmanaged)} unmanaged application policies with the explicit configured allowlist.')
    body = app_body(existing, name, hosts, policies, idps)
    print(('APPLY ' if apply else 'PLAN ') + name + ': ' + ', '.join(hosts))
    if not apply:
        return existing
    if existing:
        references = []
        for target in policies:
            matches = [p for p in current_policies if p.get('name') == target['name']]
            if len(matches) > 1:
                raise SetupError('Duplicate managed policy names on ' + name)
            if matches:
                current = matches[0]
                if any(current.get(key, [] if isinstance(value, list) else None) != value
                       for key, value in target.items()):
                    current = api.write('PUT', api.base + '/access/apps/' + existing['id'] + '/policies/' + current['id'], target)
            else:
                current = api.write('POST', api.base + '/access/apps/' + existing['id'] + '/policies', target)
            references.append({'id': current['id']})
        body['policies'] = references
        return api.write('PUT', api.base + '/access/apps/' + existing['id'], body)
    created = api.write('POST', api.base + '/access/apps', body)
    apps.append(created)
    return created



def adopt_bridge(config, api, apps, hosts):
    """Recover an existing exact-path Service Auth app without rotating credentials."""
    bridge_hosts = [h + '/v1/bridge/*' for h in hosts]
    existing = select_app(apps, 'photointel-bridge', bridge_hosts)
    if not existing:
        return None
    extra = config.setdefault('extra_environment', {})
    configured = extra.get('ACCESS_BRIDGE_SERVICE_TOKENS', '[]')
    configured = json.loads(configured) if isinstance(configured, str) else configured
    if not configured:
        policies = api.pages(api.base + '/access/apps/' + existing['id'] + '/policies')
        service_ids = set()
        for p in policies:
            if (existing.get('name') == 'photointel-bridge' and p.get('name') == MANAGED_POLICY
                    and all(p.get(k, []) == policy(desired(config)['emails'])[k] for k in ('decision', 'include', 'exclude', 'require'))):
                continue
            # Never drop policy constraints or adopt Bypass/everyone rules.
            if p.get('decision') != 'non_identity' or p.get('exclude') or p.get('require'):
                raise SetupError('Existing Bridge policies need explicit service-token configuration; refusing to broaden access')
            rules = p.get('include', [])
            if not rules:
                raise SetupError('Existing Bridge policy has no explicit service token')
            for rule in rules:
                token = rule.get('service_token', {})
                if set(rule) != {'service_token'} or not token.get('token_id'):
                    raise SetupError('Existing Bridge policy is not restricted to explicit service tokens')
                service_ids.add(token['token_id'])
        if not service_ids:
            raise SetupError('Existing Bridge app has no Service Auth policy to adopt')
        tokens = api.pages(api.base + '/access/service_tokens')
        selected = [t for t in tokens if t.get('id') in service_ids]
        if len(selected) != len(service_ids) or any(not t.get('client_id') for t in selected):
            raise SetupError('Existing Bridge service tokens could not be resolved')
        extra['ACCESS_BRIDGE_SERVICE_TOKENS'] = json.dumps(sorted(t['client_id'] for t in selected))
        print('Adopt existing Bridge: reuse app ID, audience and ' + str(len(selected)) + ' service token(s); no credential rotation.')
    extra['ACCESS_BRIDGE_AUDIENCE'] = existing.get('aud', '')
    return existing


def inspect(config, api):
    spec = desired(config)
    apps = api.pages(api.base + '/access/apps')
    idps = api.pages(api.base + '/access/identity_providers')
    # Do not rename or create a team organization: the configured issuer already
    # identifies the user's team and changing it would invalidate other apps.
    org = api.get(api.base + '/access/organizations')
    auth_domain = org.get('auth_domain', '').removeprefix('https://').rstrip('/')
    if auth_domain != spec['team']:
        raise SetupError('Configured ACCESS_TEAM_DOMAIN does not match this Cloudflare account organization')
    worker_domains = api.pages(api.base + '/workers/domains')
    legacy = sorted(d['hostname'] for d in worker_domains
                    if d.get('service') == 'photointel-api-relay' and d.get('hostname') == 'api.' + spec['host'])
    hosts = [spec['host'], *legacy]
    # Path-specific applications win over the parent app. Never silently leave a
    # conflicting Bypass or unrelated path policy shadowing the intended app.
    bridge = adopt_bridge(config, api, apps, hosts)
    bridge_enabled = bridge is not None or bool(json.loads(config.get('extra_environment', {}).get('ACCESS_BRIDGE_SERVICE_TOKENS', '[]')))
    for app in apps:
        nested = [v for v in domains(app) if any(v.startswith(h + '/') for h in hosts)]
        allowed_bridge = (app is bridge or app.get('name') == 'photointel-bridge') and bridge_enabled and all(
            v in [h + '/v1/bridge/*' for h in hosts] for v in nested)
        if nested and not allowed_bridge:
            policies = api.pages(api.base + '/access/apps/' + app['id'] + '/policies')
            print('ACCESS_CONFLICT ' + json.dumps({
                'name': app.get('name'), 'type': app.get('type'), 'paths': sorted(domains(app)),
                'policies': [{'decision': p.get('decision'),
                              'include_types': [sorted(r) for r in p.get('include', [])],
                              'exclude_types': [sorted(r) for r in p.get('exclude', [])],
                              'require_types': [sorted(r) for r in p.get('require', [])]}
                             for p in policies]}, sort_keys=True), flush=True)
            raise SetupError('A path-specific Access app overlaps PhotoIntel. Inventory its policies before consolidation: ' + str(nested))
    # Fail on conflicting apps before creating any resource.
    select_app(apps, 'photointel', hosts, config.get('access_audience'))
    return spec, apps, idps, hosts


def r2_reconcile(api, bucket, apply):
    path = api.base + '/r2/buckets/' + urllib.parse.quote(bucket, safe='')
    existing = api.get(path, missing=True)
    print(('APPLY ' if apply else 'PLAN ') + 'private R2 bucket: ' + bucket)
    if existing is None:
        if not apply:
            return
        api.write('POST', api.base + '/r2/buckets', {'name': bucket})
    managed = api.get(path + '/domains/managed')
    custom = api.get(path + '/domains/custom')
    custom_domains = custom.get('domains', []) if isinstance(custom, dict) else custom
    if any(d.get('enabled', False) for d in custom_domains):
        raise SetupError('R2 bucket has a public custom domain. Refusing to silently remove that unrelated domain.')
    if managed.get('enabled') and apply:
        api.write('PUT', path + '/domains/managed', {'enabled': False})
    elif managed.get('enabled'):
        print('PLAN disable public r2.dev domain')


def bridge_reconcile(config, api, apps, hosts, apply):
    extra = config.get('extra_environment', {})
    raw = extra.get('ACCESS_BRIDGE_SERVICE_TOKENS', '[]')
    ids = json.loads(raw) if isinstance(raw, str) else raw
    if not ids:
        print('Bridge Service Auth: disabled (no configured device service-token IDs); all paths remain protected by human Access.')
        return None
    if not isinstance(ids, list) or any(not isinstance(x, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,255}', x) for x in ids):
        raise SetupError('Invalid existing Bridge service-token IDs')
    tokens = api.pages(api.base + '/access/service_tokens')
    selected = [t for t in tokens if t.get('client_id') in ids]
    if len(selected) != len(set(ids)):
        raise SetupError('Configured Bridge service token not found; credentials are never rotated or invented during setup')
    rules = [{'service_token': {'token_id': t['id']}} for t in selected]
    bridge_hosts = [h + '/v1/bridge/*' for h in hosts]
    human_policy = policy(desired(config)['emails'])
    human_policy['precedence'] = 2
    policies = [{'name': 'photointel-bridge-service', 'decision': 'non_identity',
                 'include': rules, 'exclude': [], 'require': [], 'precedence': 1}, human_policy]
    return reconcile_app(api, apps, 'photointel-bridge', bridge_hosts,
                         extra.get('ACCESS_BRIDGE_AUDIENCE'), policies, apply)


def sync_config(config, api=None, require=False):
    api = api or client(config)
    apps = api.pages(api.base + '/access/apps')
    host = desired(config)['host']
    managed = [a for a in apps if a.get('name') == 'photointel' and host in domains(a)]
    if not managed:
        if require:
            raise SetupError('Managed Access app missing: run Cloudflare Setup apply first')
        return config
    if len(managed) != 1:
        raise SetupError('Ambiguous managed Access application')
    audience = managed[0].get('aud', '')
    if not re.fullmatch(r'[a-fA-F0-9]{64}', audience):
        raise SetupError('Cloudflare returned an invalid application audience')
    config['access_audience'] = audience
    bridge = [a for a in apps if a.get('name') == 'photointel-bridge' and host + '/v1/bridge/*' in domains(a)]
    if len(bridge) > 1:
        raise SetupError('Ambiguous Bridge Access app')
    if bridge:
        adopt_bridge(config, api, apps, [host])
        aud = bridge[0].get('aud', '')
        if not re.fullmatch(r'[a-fA-F0-9]{64}', aud):
            raise SetupError('Cloudflare returned invalid Bridge audience')
        config.setdefault('extra_environment', {})['ACCESS_BRIDGE_AUDIENCE'] = aud
    return config


def save_config(config):
    path = ROOT / 'infra/gcp/config.local.json'
    path.write_text(json.dumps(config, indent=2) + '\n')
    path.chmod(0o600)


def sync_runtime(config):
    project, region = config['project_id'], config['region']
    values = {'ACCESS_AUDIENCE': config['access_audience'], 'ACCESS_TEAM_DOMAIN': config['access_team_domain']}
    for key in ('ACCESS_BRIDGE_AUDIENCE', 'ACCESS_BRIDGE_SERVICE_TOKENS'):
        if key in config.get('extra_environment', {}):
            values[key] = config['extra_environment'][key]
    if any('|' in value for value in values.values()):
        raise SetupError('Unexpected environment delimiter')
    update = '^|^' + '|'.join(key + '=' + value for key, value in values.items())
    # Update only auth metadata, preserving images, secret references and other env.
    def run(args):
        result = subprocess.run(['gcloud', *args, '--project', project, '--quiet'], capture_output=True, text=True)
        if result.returncode:
            raise SetupError('Cloud Run auth synchronization failed; verify deployer run.admin permission and existing API health')
        return result.stdout
    run(['run', 'services', 'update', 'photointel-api', '--region', region, '--update-env-vars', update])
    jobs = json.loads(run(['run', 'jobs', 'list', '--region', region, '--format=json']))
    for job in jobs:
        name = job.get('metadata', {}).get('name', '').rsplit('/', 1)[-1]
        if name.startswith('photointel-'):
            run(['run', 'jobs', 'update', name, '--region', region, '--update-env-vars', update])
    print('Cloud Run API/Jobs auth metadata synchronized without Docker build.')


def reconcile(config, api, apply=False):
    spec, apps, idps, hosts = inspect(config, api)
    r2_reconcile(api, spec['bucket'], False)
    otp = [p for p in idps if p.get('type') == 'onetimepin']
    if not otp and apply:
        otp = [api.write('POST', api.base + '/access/identity_providers',
                         {'name': 'PhotoIntel email PIN', 'type': 'onetimepin', 'config': {}})]
    elif not otp:
        print('PLAN create One-time PIN login provider')
    app = reconcile_app(api, apps, 'photointel', hosts, config.get('access_audience'),
                        [policy(spec['emails'])], apply, [p['id'] for p in otp])
    bridge_reconcile(config, api, apps, hosts, apply)
    r2_reconcile(api, spec['bucket'], apply)
    if apply:
        # Re-read official API, do not rely on locally guessed audiences.
        sync_config(config, api, require=True)
        save_config(config)
        sync_runtime(config)
    summary = {'mode': 'apply' if apply else 'plan', 'worker': 'photointel', 'domains': hosts,
               'paths': {'human': 'whole hostname', 'api': '/v1/*', 'login': '/auth/login',
                         'bridge': '/v1/bridge/* only when service IDs are configured'},
               'r2': spec['bucket'], 'access_app_id': app.get('id') if app else None}
    print(json.dumps(summary, indent=2))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write('### Cloudflare setup\n\n```json\n' + json.dumps(summary, indent=2) + '\n```\n')


def verify(config):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    host = desired(config)['host']
    opener = urllib.request.build_opener(NoRedirect)
    found = []
    for path in ('/', '/library', '/v1/info'):
        try:
            with opener.open('https://' + host + path, timeout=30) as response:
                status, location = response.status, response.headers.get('Location', '')
        except urllib.error.HTTPError as exc:
            status, location = exc.code, exc.headers.get('Location', '')
            exc.close()
        login_host = urllib.parse.urlsplit(location).hostname
        expected = status in (302, 303, 307, 308) and login_host == config['access_team_domain']
        found.append({'path': path, 'status': status, 'login_redirect': expected})
    print('ACCESS_VERIFICATION=' + json.dumps(found))
    if not all(item['login_redirect'] for item in found):
        raise SetupError('Anonymous requests did not all redirect to Access. Check WAF, policies or propagation; no authenticated session was claimed.')


def main():
    from prepare_workflow_env import read_config
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'apply', 'sync', 'verify'))
    args = parser.parse_args()
    config = read_config()
    try:
        if args.action == 'sync':
            sync_config(config)
            save_config(config)
        elif args.action == 'verify':
            verify(config)
        else:
            reconcile(config, client(config), args.action == 'apply')
    except (SetupError, ValueError, KeyError) as exc:
        print('::error::' + str(exc))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
