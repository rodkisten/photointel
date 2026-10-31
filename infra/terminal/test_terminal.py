"""Offline tests of cost boundaries, command authorization and VM lifecycle."""
import unittest
import json
from datetime import datetime, timezone
import boot_logs
from unittest.mock import patch

import terminal


def base():
    return dict(project_id='photointel', region='us-central1', repository='photointel',
                release_git_sha='a' * 40,
                workflow_secrets={key: {'name': 'test-' + str(i), 'version': '1'} for i, key in
                                  enumerate(('TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'))})


class FakeGcloud:
    def __init__(self, existing=None):
        self.calls = []
        self.existing = existing

    def run(self, *args, **kwargs):
        self.calls.append(args)
        if args[:3] == ('secrets', 'versions', 'describe'):
            return {'state': 'ENABLED'}
        if args[:3] == ('compute', 'instances', 'describe'):
            return self.existing
        if args[:3] == ('compute', 'addresses', 'list'):
            return []
        if kwargs.get('optional'):
            return None
        return {}


class TerminalTests(unittest.TestCase):
    def test_tailscale_apt_public_key_is_readable_and_repaired_before_update(self):
        # Regression: umask 077 used to create the public keyring with mode
        # 0600, so APT running as _apt could not verify the repository GPG key.
        script = (terminal.ROOT / 'infra/terminal/startup.sh').read_text()
        repair = script.index('chmod 0644 "$apt_public_file"')
        first_update = script.index('apt-get update -qq')
        self.assertLess(repair, first_update)
        self.assertIn('install -m 0644 "$tailscale_stage/keyring.gpg" "$tailscale_keyring"', script)
        self.assertIn('install -m 0644 "$tailscale_stage/tailscale.list" "$tailscale_sources"', script)
        self.assertIn('test -s "$tailscale_stage/keyring.gpg"', script)
        self.assertIn('test -s "$tailscale_stage/tailscale.list"', script)
        self.assertIn('tailscale-archive-keyring', script)
        self.assertIn('umask 077', script)
        self.assertIn('source installed', script)

    def test_defaults_bound_costs_and_keep_existing_oauth_references(self):
        c = terminal.configuration(base())
        self.assertEqual(c['disk_gb'], 30)
        self.assertEqual(c['max_minutes'], 120)
        self.assertEqual(c['zone'], 'us-central1-a')
        self.assertTrue(c['image'].endswith('/terminal:ready'))
        self.assertEqual(c['oauth'], base()['workflow_secrets'])

    def test_reject_invalid_or_paid_configuration(self):
        for field, value in [('disk_gb', 31), ('max_minutes', 0), ('max_minutes', '120'),
                             ('zone', 'southamerica-east1-a'), ('tag', 'tag:ci;evil'),
                             ('network', 'default --foo'), ('unexpected', True)]:
            raw = base()
            raw['terminal'] = {field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                terminal.configuration(raw)
        raw = base()
        raw['region'] = 'southamerica-east1'
        with self.assertRaises(ValueError):
            terminal.configuration(raw)

    def test_missing_secret_ref_fails_before_any_cloud_operation(self):
        raw = base()
        raw['workflow_secrets']['TS_OAUTH_SECRET'] = {'name': 'x', 'version': 'latest'}
        with self.assertRaises(ValueError):
            terminal.configuration(raw)

    def test_create_uses_standard_disk_without_static_ip_or_wide_runtime_roles(self):
        c = terminal.configuration(base())
        g = FakeGcloud()
        terminal.provision(c, g, 'photointel-deployer@photointel.iam.gserviceaccount.com')
        create = next(x for x in g.calls if x[:3] == ('compute', 'instances', 'create'))
        self.assertIn('--machine-type=e2-micro', create)
        self.assertIn('--boot-disk-type=pd-standard', create)
        self.assertIn('--max-run-duration=120m', create)
        self.assertIn('--instance-termination-action=STOP', create)
        self.assertFalse(any('address=' in arg for arg in create))
        bindings = [x for x in g.calls if 'add-iam-policy-binding' in x]
        runtime = [x for x in bindings if '--member=serviceAccount:' + c['account'] in x]
        self.assertEqual(len(runtime), 3)
        self.assertFalse(any('--role=roles/editor' in x for x in bindings))
        firewall = next(x for x in g.calls if x[:3] == ('compute', 'firewall-rules', 'create'))
        self.assertIn('--priority=0', firewall)
        self.assertIn('--action=DENY', firewall)

    def test_does_not_adopt_other_workloads(self):
        c = terminal.configuration(base())
        with self.assertRaises(ValueError):
            terminal.provision(c, FakeGcloud({'labels': {}}), 'deployer')

    def test_reprovision_stops_before_updating_and_restarts(self):
        c = terminal.configuration(base())
        g = FakeGcloud({'labels': {'purpose': 'terminal'}, 'machineType': 'zones/x/e2-micro',
                        'status': 'RUNNING', 'networkInterfaces': []})
        terminal.provision(c, g, 'deployer')
        operations = [x[2] for x in g.calls if x[:2] == ('compute', 'instances')]
        self.assertLess(operations.index('stop'), operations.index('add-metadata'))
        self.assertLess(operations.index('add-metadata'), operations.index('start'))


    def test_oauth_preflight_fails_before_vm_mutation(self):
        c = terminal.configuration(base())

        class Disabled(FakeGcloud):
            def run(self, *args, **kwargs):
                if args[:3] == ('secrets', 'versions', 'describe'):
                    self.calls.append(args)
                    return {'state': 'DISABLED'}
                return super().run(*args, **kwargs)

        g = Disabled()
        with self.assertRaisesRegex(RuntimeError, 'not ENABLED'):
            terminal.provision(c, g, 'deployer')
        self.assertFalse(any(x[:2] == ('compute', 'instances') for x in g.calls))
        self.assertFalse(any(x[:2] == ('services', 'enable') for x in g.calls))

        class NotFound(FakeGcloud):
            def run(self, *args, **kwargs):
                if args[:3] == ('secrets', 'versions', 'describe'):
                    raise RuntimeError('PROVIDER_ERROR confidential-gcp-detail')
                return super().run(*args, **kwargs)

        with self.assertRaisesRegex(RuntimeError, 'TS_OAUTH_CLIENT_ID') as caught:
            terminal.provision(c, NotFound(), 'deployer')
        self.assertNotIn('confidential-gcp-detail', str(caught.exception))

    def test_serial_boot_events_only_show_safe_current_boot_details(self):
        boot = datetime(2026, 10, 31, 14, 47, 25, tzinfo=timezone.utc)
        lines = '\\n'.join([
            '2026-10-31T14:41:01Z photointel-terminal google_metadata_script_runner: Terminal ready: ssh rod@100.1.2.3. Maximum uptime: 120 minutes.',
            '2026-10-31T14:47:42Z photointel-terminal google_metadata_script_runner: Metadata key("startup-script"), command("/bin/bash"): terminal-startup: apt source permissions checked',
            '2026-10-31T14:47:55Z photointel-terminal google_metadata_script_runner: Metadata key("startup-script"), command("/bin/bash"): curl: (22) The requested URL returned error: 404',
            '2026-10-31T14:47:55Z photointel-terminal google_metadata_script_runner: Metadata key("startup-script"), command("/bin/bash"): terminal-startup: FAILED stage=tailscale-auth secret=TS_OAUTH_CLIENT_ID version=1',
            '2026-10-31T14:47:55Z photointel-terminal google_metadata_script_runner: secret-value=NEVER_PRINT',
            '2026-10-31T14:47:56Z photointel-terminal google_metadata_script_runner: Script "startup-script" failed with error: exit status 22',
            '2026-10-31T14:47:56Z photointel-terminal google_guest_agent: cloud logging permission denied',
        ])
        output = boot_logs.events(lines, boot)
        messages = [message for _, message in output]
        self.assertTrue(any('apt source permissions checked' in m for m in messages))
        self.assertTrue(any('curl returned HTTP 404' in m for m in messages))
        self.assertTrue(any('TS_OAUTH_CLIENT_ID' in m for m in messages))
        self.assertTrue(any('Startup script exited with status 22' in m for m in messages))
        self.assertFalse(any('100.1.2.3' in m for m in messages))
        self.assertFalse(any('NEVER_PRINT' in m for m in messages))
        self.assertFalse(any('cloud logging' in m for m in messages))

    def test_serial_boot_logs_reports_success_without_dumping_provider_output(self):
        boot = datetime(2026, 10, 31, 14, 47, 25, tzinfo=timezone.utc)
        messages = '2026-10-31T14:47:59Z photointel-terminal google_metadata_script_runner: Terminal ready: ssh rod@100.10.20.30. Maximum uptime: 120 minutes.'
        with (
            patch('boot_logs.get_boot_time', return_value=boot),
            patch('boot_logs.get_serial', return_value=messages),
            patch('builtins.print') as printed,
        ):
            self.assertEqual(boot_logs.watch('photointel-terminal', 'us-central1-a', timeout_seconds=15), 0)
        self.assertTrue(any('Terminal ready' in str(call) for call in printed.call_args_list))

    def test_ready_image_resolved_with_docker_not_metadata_api(self):
        c = terminal.configuration(base())
        digest = 'sha256:' + 'b' * 64
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if args[:3] == ['docker', 'image', 'inspect']:
                return unittest.mock.Mock(returncode=0, stdout=json.dumps([
                    terminal.image_base(c) + '@' + digest,
                ]), stderr='')
            return unittest.mock.Mock(returncode=0, stdout='', stderr='')

        with patch('subprocess.run', side_effect=fake_run):
            result = terminal.resolve_image(c, unittest.mock.Mock())
        self.assertEqual(result, terminal.image_base(c) + '@' + digest)
        self.assertIn(['docker', 'pull', c['image']], calls)
        self.assertFalse(any(args[:2] == ['gcloud', 'artifacts'] for args in calls))

    def test_build_reuses_fingerprint_image_and_publishes_ready_with_docker(self):
        c = terminal.configuration(base())
        digest = 'sha256:' + 'c' * 64
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if args[:3] == ['docker', 'image', 'inspect']:
                return unittest.mock.Mock(returncode=0, stdout=json.dumps([
                    terminal.image_base(c) + '@' + digest,
                ]), stderr='')
            return unittest.mock.Mock(returncode=0, stdout='', stderr='')

        with (
            patch('subprocess.run', side_effect=fake_run),
            patch.object(terminal.Path, 'read_bytes', return_value=b'Dockerfile fixture'),
        ):
            terminal.build_image(c, unittest.mock.Mock())
        self.assertNotIn('build', [args[1] for args in calls if args[0] == 'docker'])
        self.assertIn(['docker', 'push', c['image']], calls)
        self.assertTrue(any(args[:2] == ['docker', 'run'] for args in calls))
        self.assertFalse(any(args[:2] == ['gcloud', 'artifacts'] for args in calls))

    def test_missing_fingerprint_image_builds_and_pins_using_docker(self):
        c = terminal.configuration(base())
        digest = 'sha256:' + 'd' * 64
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if args[:2] == ['docker', 'pull'] and not any(
                step[:2] == ['docker', 'build'] for step in calls
            ):
                return unittest.mock.Mock(returncode=1, stdout='',
                    stderr='manifest unknown: not found')
            if args[:3] == ['docker', 'image', 'inspect']:
                return unittest.mock.Mock(returncode=0, stdout=json.dumps([
                    terminal.image_base(c) + '@' + digest,
                ]), stderr='')
            return unittest.mock.Mock(returncode=0, stdout='', stderr='')

        with (
            patch('subprocess.run', side_effect=fake_run),
            patch.object(terminal.Path, 'read_bytes', return_value=b'Dockerfile fixture'),
        ):
            terminal.build_image(c, unittest.mock.Mock())
        self.assertTrue(any(args[:2] == ['docker', 'build'] for args in calls))
        self.assertTrue(any(args[:2] == ['docker', 'push'] for args in calls))

    def test_no_ready_image_does_not_trigger_implicit_build(self):
        def fake_run(args, **kwargs):
            if args[:2] == ['docker', 'pull']:
                return unittest.mock.Mock(returncode=1, stdout='',
                    stderr='manifest unknown: not found')
            return unittest.mock.Mock(returncode=0, stdout='', stderr='')
        with patch('subprocess.run', side_effect=fake_run) as process:
            with self.assertRaisesRegex(ValueError, 'action=build'):
                terminal.resolve_image(terminal.configuration(base()), unittest.mock.Mock())
        self.assertFalse(any(call.args[0][:2] == ['docker', 'build']
                             for call in process.call_args_list))

    def test_missing_vs_denied_manifest_fail_closed(self):
        with patch('subprocess.run', return_value=unittest.mock.Mock(
            returncode=1, stdout='', stderr='manifest unknown: not found'
        )):
            self.assertFalse(terminal.pull_image('image:missing', optional=True))
        with patch('subprocess.run', return_value=unittest.mock.Mock(
            returncode=1, stdout='', stderr='403 forbidden password=SECRET_VALUE'
        )):
            with self.assertRaisesRegex(RuntimeError, 'Docker registry denied') as caught:
                terminal.pull_image('image:private', optional=True)
        self.assertNotIn('SECRET_VALUE', str(caught.exception))

    def test_bad_docker_digest_refused(self):
        with patch('subprocess.run', return_value=unittest.mock.Mock(
            returncode=0, stdout='["attacker.invalid/repo@sha256:' + 'a' * 64 + '"]',
            stderr='',
        )):
            with self.assertRaisesRegex(RuntimeError, 'cannot be verified'):
                terminal.image_digest('image:tag', 'expected.registry/repo')

    def test_firewall_permission_denial_is_not_missing_and_does_not_leak_output(self):
        import subprocess
        error = 'Required permission compute.firewalls.get denied. secret-token-value'
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', error)):
            with self.assertRaisesRegex(RuntimeError, 'roles/compute.securityAdmin') as caught:
                terminal.Gcloud('photointel').run('compute', 'firewall-rules', 'describe', 'x', optional=True)
        self.assertNotIn('secret-token-value', str(caught.exception))

    def test_gcloud_metadata_denial_is_sanitized_not_misdiagnosed_as_registry_iam(self):
        import subprocess
        raw_error = 'PERMISSION_DENIED iam.gserviceaccount.com private-secret=NEVER_PRINT'
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', raw_error)):
            with self.assertRaisesRegex(RuntimeError, 'Container Analysis') as caught:
                terminal.Gcloud('photointel').run(
                    'artifacts', 'docker', 'images', 'describe',
                    'us-central1-docker.pkg.dev/photointel/photointel/terminal:ready',
                    optional=True,
                )
        self.assertNotIn('NEVER_PRINT', str(caught.exception))

    def test_resource_does_not_exist_is_optional(self):
        import subprocess
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'resource does not exist')):
            self.assertIsNone(terminal.Gcloud('photointel').run('compute', 'firewall-rules', 'describe', 'x', optional=True))

    def test_gcloud_only_treats_not_found_as_missing(self):
        import subprocess
        g = terminal.Gcloud('photointel')
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'PERMISSION_DENIED')):
            with self.assertRaises(RuntimeError):
                g.run('compute', 'instances', 'describe', 'x', optional=True)
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'NOT_FOUND')):
            self.assertIsNone(g.run('compute', 'instances', 'describe', 'x', optional=True))


if __name__ == '__main__':
    unittest.main()

