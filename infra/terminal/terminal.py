#!/usr/bin/env python3
"""On-demand terminal VM; all configuration derives from config.local.json."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def configuration(raw: dict) -> dict:
    project, region, repository = (raw[k] for k in ('project_id', 'region', 'repository'))
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', project):
        raise ValueError('Invalid project')
    if region not in {'us-central1', 'us-east1', 'us-west1'}:
        raise ValueError('Terminal requires a Compute Engine Free Tier eligible region')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,61}[a-z0-9]', repository):
        raise ValueError('Invalid Artifact Registry repository')
    settings = raw.get('terminal', {})
    if set(settings) - {'name', 'zone', 'max_minutes', 'tag', 'disk_gb', 'network', 'subnet'}:
        raise ValueError('Unknown terminal configuration field')
    name = settings.get('name', 'photointel-terminal')
    zone = settings.get('zone', region + '-a')
    minutes = settings.get('max_minutes', 120)
    size = settings.get('disk_gb', 30)
    tag = settings.get('tag', 'tag:ci')
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', name):
        raise ValueError('Invalid terminal name')
    if not re.fullmatch(re.escape(region) + r'-[a-z]', zone):
        raise ValueError('Zone must belong to configured region')
    if type(minutes) is not int or not 15 <= minutes <= 720:
        raise ValueError('max_minutes must be an integer from 15 to 720')
    if type(size) is not int or not 10 <= size <= 30:
        raise ValueError('disk_gb must be an integer from 10 to 30')
    if not re.fullmatch(r'tag:[a-z][a-z0-9-]{0,50}', tag):
        raise ValueError('Invalid Tailscale tag')
    sha = raw.get('release_git_sha', '')
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('A full release Git SHA is required')
    oauth = {}
    for key in ('TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'):
        ref = raw.get('workflow_secrets', {}).get(key, {})
        if (set(ref) != {'name', 'version'} or
            not re.fullmatch(r'[a-z][a-z0-9-]{0,254}', str(ref.get('name', ''))) or
            not re.fullmatch(r'[1-9][0-9]{0,9}', str(ref.get('version', '')))):
            raise ValueError('Missing or invalid Secret Manager reference: ' + key)
        oauth[key] = ref
    for key in ('network', 'subnet'):
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,61}[a-z0-9]|[a-z]', settings.get(key, 'default')):
            raise ValueError('Invalid ' + key)
    return dict(project=project, region=region, repository=repository, name=name, zone=zone,
                max_minutes=minutes, disk_gb=size, tag=tag, oauth=oauth,
                network=settings.get('network', 'default'), subnet=settings.get('subnet', 'default'),
                image=f'{region}-docker.pkg.dev/{project}/{repository}/terminal:ready',
                account=f'{name}@{project}.iam.gserviceaccount.com')


class Gcloud:
    def __init__(self, project):
        self.project = project

    def run(self, *args, optional=False):
        result = subprocess.run(['gcloud', *args, '--project', self.project, '--quiet', '--format=json'],
                                capture_output=True, text=True, check=False)
        if result.returncode:
            # Classify only safe codes/permission identifiers, never dump raw output.
            error = result.stderr.lower()
            denied = any(code in error for code in ('permission_denied', 'permission denied',
                         'does not have permission', 'forbidden', '403', 'required permission'))
            if optional and not denied and any(code in error for code in
                    ('not_found', 'was not found', 'does not exist', 'not found', '404')):
                return None
            details = sorted(set(re.findall(r'\b(?:compute|iam|artifactregistry|serviceusage)\.[A-Za-z]+\.[A-Za-z]+\b', result.stderr)))
            reason = 'PERMISSION_DENIED' if denied else ('UNAUTHENTICATED' if
                     'unauthenticated' in error else 'PROVIDER_ERROR')
            hint = ''
            if args[:2] == ('compute', 'firewall-rules') and denied:
                hint = ' Run Setup GCP apply: bootstrap needs roles/compute.securityAdmin.'
            raise RuntimeError('gcloud failed: ' + ' '.join(args[:4]) + ': ' + reason +
                               (' (' + ', '.join(details) + ')' if details else '') + hint)
        return json.loads(result.stdout) if result.stdout.strip() else {}



def image_base(c):
    return c['image'].rsplit(':', 1)[0]


def pinned_image(base, description):
    digest = description.get('image_summary', {}).get('digest', '')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
        raise ValueError('Artifact Registry returned an invalid image digest')
    return base + '@' + digest


def resolve_image(c, g):
    """Reuse published ready image; migrate existing SHA images without Docker builds."""
    base = image_base(c)
    info = g.run('artifacts', 'docker', 'images', 'describe', c['image'], optional=True)
    if info is not None:
        return pinned_image(base, info)
    versions = g.run('artifacts', 'docker', 'images', 'list', base,
                     '--include-tags', '--sort-by=~createTime', '--limit=1')
    if not versions:
        raise ValueError('No published terminal image. Run GCP Terminal action=build once; provision never builds Docker.')
    digest = versions[0].get('version', '').rsplit('/', 1)[-1]
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
        raise ValueError('Artifact Registry returned an invalid existing image version')
    print('Reusing previously published terminal image (no Docker build).')
    return base + '@' + digest


def build_image(c, g):
    """Explicit build command; content tag ignores unrelated repository commits."""
    directory = ROOT / 'infra/terminal'
    fingerprint = hashlib.sha256((directory / 'Dockerfile').read_bytes()).hexdigest()
    base = image_base(c)
    image = base + ':cli-' + fingerprint
    existing = g.run('artifacts', 'docker', 'images', 'describe', image, optional=True)
    if existing is None:
        registry = base.split('/', 1)[0]
        subprocess.run(['gcloud', 'auth', 'configure-docker', registry, '--quiet'], check=True)
        subprocess.run(['docker', 'build', '--pull', '-t', image, str(directory)], check=True)
        check = ('test "$(id -un)" = rod; test "$(id -u)" = 1000; '
                 'test "$(id -g)" = 1000; test -w /home/rod; '
                 'for tool in gcloud jq awk ssh sshd git tmux rsync python3 psql sqlite3 rg fzf; '
                 'do command -v "$tool" || exit 1; done; gcloud version')
        subprocess.run(['docker', 'run', '--rm', '--entrypoint', 'bash', image, '-ec', check], check=True)
        subprocess.run(['docker', 'push', image], check=True)
        existing = g.run('artifacts', 'docker', 'images', 'describe', image)
    else:
        print('CLI Dockerfile unchanged: reusing published content-addressed image.')
    pinned = pinned_image(base, existing)
    g.run('artifacts', 'docker', 'tags', 'add', pinned, c['image'])
    print('Terminal image ready: ' + pinned)


def provision(c, g, deployer):
    g.run('services', 'enable', 'compute.googleapis.com', 'secretmanager.googleapis.com',
          'artifactregistry.googleapis.com', 'iam.googleapis.com')
    if g.run('iam', 'service-accounts', 'describe', c['account'], optional=True) is None:
        g.run('iam', 'service-accounts', 'create', c['name'], '--display-name=On-demand CLI terminal')
    g.run('iam', 'service-accounts', 'add-iam-policy-binding', c['account'],
          '--member=serviceAccount:photointel-bootstrap@' + c['project'] + '.iam.gserviceaccount.com',
          '--role=roles/iam.serviceAccountUser', '--condition=None')
    # Runtime identity can pull terminal images and read only the two existing OAuth secrets.
    g.run('artifacts', 'repositories', 'add-iam-policy-binding', c['repository'],
          '--location', c['region'], '--member=serviceAccount:' + c['account'],
          '--role=roles/artifactregistry.reader', '--condition=None')
    for ref in c['oauth'].values():
        g.run('secrets', 'add-iam-policy-binding', ref['name'],
              '--member=serviceAccount:' + c['account'], '--role=roles/secretmanager.secretAccessor', '--condition=None')
    role = 'photointelTerminalOperator'
    permissions = 'compute.instances.get,compute.instances.start,compute.instances.stop'
    exists = g.run('iam', 'roles', 'describe', role, optional=True)
    g.run('iam', 'roles', 'update' if exists is not None else 'create', role,
          '--title=PhotoIntel terminal power control', '--permissions=' + permissions, '--stage=GA')
    firewall = c['name'] + '-deny-ingress'
    rule = g.run('compute', 'firewall-rules', 'describe', firewall, optional=True)
    if rule is None:
        g.run('compute', 'firewall-rules', 'create', firewall, '--network', c['network'],
              '--direction=INGRESS', '--priority=0', '--action=DENY', '--rules=all',
              '--source-ranges=0.0.0.0/0', '--target-tags=' + c['name'])
    else:
        if (rule.get('network', '').split('/')[-1] != c['network'] or
            rule.get('priority') != 0 or rule.get('disabled', False) or
            rule.get('targetTags') != [c['name']] or
            rule.get('sourceRanges') != ['0.0.0.0/0'] or
            rule.get('denied') != [{'IPProtocol': 'all'}]):
            raise ValueError('Existing terminal ingress firewall differs from required deny-all rule')
    instance = g.run('compute', 'instances', 'describe', c['name'], '--zone', c['zone'], optional=True)
    with tempfile.TemporaryDirectory() as directory:
        config = Path(directory) / 'terminal.json'
        config.write_text(json.dumps(c))
        config.chmod(0o600)
        metadata = ('terminal-config=' + str(config) + ',startup-script=' +
                    str(ROOT / 'infra/terminal/startup.sh'))
        if instance is None:
            g.run('compute', 'instances', 'create', c['name'], '--zone', c['zone'],
                  '--machine-type=e2-micro', '--max-run-duration=' + str(c['max_minutes']) + 'm',
                  '--instance-termination-action=STOP', '--no-restart-on-failure', '--image-family=debian-12', '--image-project=debian-cloud',
                  '--boot-disk-type=pd-standard', '--boot-disk-size=' + str(c['disk_gb']) + 'GB',
                  '--network', c['network'], '--subnet', c['subnet'], '--network-tier=STANDARD',
                  '--service-account', c['account'], '--scopes=cloud-platform',
                  '--tags=' + c['name'], '--labels=app=photointel,purpose=terminal',
                  '--shielded-secure-boot', '--metadata=block-project-ssh-keys=true,serial-port-enable=false',
                  '--metadata-from-file=' + metadata)
        else:
            # Fail instead of adopting a different VM or one with a reserved address.
            if instance.get('labels', {}).get('purpose') != 'terminal':
                raise ValueError('Refusing to adopt an existing non-terminal VM')
            if not instance.get('machineType', '').endswith('/e2-micro'):
                raise ValueError('Existing VM is not e2-micro')
            addresses = g.run('compute', 'addresses', 'list')
            reserved = {x.get('address') for x in addresses}
            ips = {a.get('natIP') for n in instance.get('networkInterfaces', []) for a in n.get('accessConfigs', [])}
            if reserved & ips:
                raise ValueError('Existing terminal uses a reserved IP; release it manually first')
            if instance['status'] != 'TERMINATED':
                g.run('compute', 'instances', 'stop', c['name'], '--zone', c['zone'])
            g.run('compute', 'instances', 'set-scheduling', c['name'], '--zone', c['zone'],
                  '--max-run-duration=' + str(c['max_minutes']) + 'm',
                  '--instance-termination-action=STOP', '--no-restart-on-failure')
            g.run('compute', 'instances', 'add-metadata', c['name'], '--zone', c['zone'],
                  '--metadata-from-file=' + metadata)
            g.run('compute', 'instances', 'start', c['name'], '--zone', c['zone'])
    g.run('compute', 'instances', 'add-iam-policy-binding', c['name'], '--zone', c['zone'],
          '--member=serviceAccount:' + deployer,
          '--role=projects/' + c['project'] + '/roles/' + role, '--condition=None')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'config', 'build', 'provision', 'start', 'stop', 'status'))
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirm-project', default='')
    opts = parser.parse_args()
    raw = json.loads((ROOT / 'infra/gcp/config.local.json').read_text())
    c = configuration(raw)
    if opts.action in {'plan', 'config'}:
        print(json.dumps(c, indent=2))
        return
    if opts.confirm_project != c['project']:
        parser.error('Project confirmation mismatch')
    if opts.action != 'status' and not opts.apply:
        parser.error('Mutation requires --apply')
    g = Gcloud(c['project'])
    if opts.action == 'build':
        build_image(c, g)
        return
    if opts.action == 'provision':
        c['image'] = resolve_image(c, g)
        deployer = os.environ.get('TERMINAL_DEPLOYER', '')
        if not re.fullmatch(r'[a-z][a-z0-9-]*@' + re.escape(c['project']) + r'\.iam\.gserviceaccount\.com', deployer):
            parser.error('TERMINAL_DEPLOYER must be the configured deployer service account')
        provision(c, g, deployer)
    elif opts.action in {'start', 'stop'}:
        state = g.run('compute', 'instances', 'describe', c['name'], '--zone', c['zone'])
        desired = 'RUNNING' if opts.action == 'start' else 'TERMINATED'
        if state['status'] != desired:
            g.run('compute', 'instances', opts.action, c['name'], '--zone', c['zone'])
    instance = g.run('compute', 'instances', 'describe', c['name'], '--zone', c['zone'])
    message = (f"VM: {c['name']} | {instance['status']}\n\n"
               f"Tailscale: `ssh rod@{c['name']}` (MagicDNS).\n\n"
               f"Maximum uptime: {c['max_minutes']} minutes per boot. "
               'RUNNING does not imply the container is ready; first boot installs packages.\n')
    print(message)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write(message)


if __name__ == '__main__':
    main()

