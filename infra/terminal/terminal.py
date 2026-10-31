#!/usr/bin/env python3
"""On-demand terminal VM; all configuration derives from config.local.json."""
from __future__ import annotations

import argparse
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
                image=f'{region}-docker.pkg.dev/{project}/{repository}/terminal:{sha}',
                account=f'{name}@{project}.iam.gserviceaccount.com')


class Gcloud:
    def __init__(self, project):
        self.project = project

    def run(self, *args, optional=False):
        result = subprocess.run(['gcloud', *args, '--project', self.project, '--quiet', '--format=json'],
                                capture_output=True, text=True, check=False)
        if result.returncode:
            # Never echo provider output: errors can contain secret values.
            if optional and ('NOT_FOUND' in result.stderr or 'was not found' in result.stderr):
                return None
            raise RuntimeError('gcloud failed: ' + ' '.join(args[:4]) + '. Check IAM/API access in Google Cloud.')
        return json.loads(result.stdout) if result.stdout.strip() else {}


def provision(c, g, deployer):
    g.run('services', 'enable', 'compute.googleapis.com', 'secretmanager.googleapis.com',
          'artifactregistry.googleapis.com', 'iam.googleapis.com')
    if g.run('iam', 'service-accounts', 'describe', c['account'], optional=True) is None:
        g.run('iam', 'service-accounts', 'create', c['name'], '--display-name=On-demand CLI terminal')
    # Runtime identity can pull terminal images and read only the two existing OAuth secrets.
    g.run('artifacts', 'repositories', 'add-iam-policy-binding', c['repository'],
          '--location', c['region'], '--member=serviceAccount:' + c['account'],
          '--role=roles/artifactregistry.reader')
    for ref in c['oauth'].values():
        g.run('secrets', 'add-iam-policy-binding', ref['name'],
              '--member=serviceAccount:' + c['account'], '--role=roles/secretmanager.secretAccessor')
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
          '--role=projects/' + c['project'] + '/roles/' + role)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'config', 'provision', 'start', 'stop', 'status'))
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
    if opts.action == 'provision':
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
