"""Offline tests of cost boundaries, command authorization and VM lifecycle."""
import unittest
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
        if args[:3] == ('compute', 'instances', 'describe'):
            return self.existing
        if args[:3] == ('compute', 'addresses', 'list'):
            return []
        if kwargs.get('optional'):
            return None
        return {}


class TerminalTests(unittest.TestCase):
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


    def test_ready_image_is_resolved_to_digest_without_build(self):
        c = terminal.configuration(base())
        digest = 'sha256:' + 'b' * 64
        g = unittest.mock.Mock()
        g.run.return_value = {'image_summary': {'digest': digest}}
        with patch('subprocess.run') as process:
            result = terminal.resolve_image(c, g)
        self.assertTrue(result.endswith('/terminal@' + digest))
        process.assert_not_called()
        self.assertEqual(g.run.call_count, 1)

    def test_legacy_sha_image_reused_without_rebuild(self):
        c = terminal.configuration(base())
        digest = 'sha256:' + 'c' * 64
        g = unittest.mock.Mock()
        g.run.side_effect = [None, [{'version': 'projects/x/versions/' + digest}]]
        with patch('subprocess.run') as process:
            result = terminal.resolve_image(c, g)
        self.assertTrue(result.endswith('@' + digest))
        process.assert_not_called()

    def test_no_image_does_not_trigger_implicit_build(self):
        g = unittest.mock.Mock()
        g.run.side_effect = [None, []]
        with patch('subprocess.run') as process, self.assertRaisesRegex(ValueError, 'action=build'):
            terminal.resolve_image(terminal.configuration(base()), g)
        process.assert_not_called()

    def test_build_reuses_content_tag_across_repository_commits(self):
        raw = base()
        first = terminal.configuration(raw)
        raw['release_git_sha'] = 'f' * 40
        second = terminal.configuration(raw)
        calls = []
        for c in (first, second):
            g = unittest.mock.Mock()
            g.run.return_value = {'image_summary': {'digest': 'sha256:' + 'd' * 64}}
            with patch.object(terminal.Path, 'read_bytes', return_value=b'identical Dockerfile'), patch('subprocess.run') as process:
                terminal.build_image(c, g)
            process.assert_not_called()
            calls.append(g.run.call_args_list[0])
        self.assertEqual(calls[0], calls[1])

    def test_firewall_permission_denial_is_not_missing_and_does_not_leak_output(self):
        import subprocess
        error = 'Required permission compute.firewalls.get denied. secret-token-value'
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', error)):
            with self.assertRaisesRegex(RuntimeError, 'roles/compute.securityAdmin') as caught:
                terminal.Gcloud('photointel').run('compute', 'firewall-rules', 'describe', 'x', optional=True)
        self.assertNotIn('secret-token-value', str(caught.exception))

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

