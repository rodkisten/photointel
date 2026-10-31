"""Reconciliation contracts without any Cloudflare/GCP access."""
import copy
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudflare_setup as app


def config():
    return {'project_id': 'photointel', 'region': 'us-central1',
            'frontend_origin': 'https://photos.migos.club',
            'access_team_domain': 'photointel.cloudflareaccess.com',
            'access_audience': 'b' * 64, 'access_allowed_emails': ['rod@example.com'],
            'storage_bucket': 'photointel', 'extra_environment': {}}


class FakeAPI:
    base = '/accounts/' + 'a' * 32

    def __init__(self):
        self.apps = []
        self.policies = {}
        self.idps = [{'id': 'otp-id', 'type': 'onetimepin'}]
        self.writes = []
        self.tokens = [{'id': 'service-id', 'client_id': 'unit.access'}]

    def pages(self, path):
        if path == self.base + '/access/apps': return copy.deepcopy(self.apps)
        if path.endswith('/identity_providers'): return self.idps
        if path.endswith('/workers/domains'): return []
        if path.endswith('/service_tokens'): return self.tokens
        if path.endswith('/policies'):
            return copy.deepcopy(self.policies.get(path.split('/')[-2], []))
        raise AssertionError(path)

    def get(self, path, missing=False):
        if path.endswith('/access/organizations'):
            return {'auth_domain': 'photointel.cloudflareaccess.com'}
        if path.endswith('/r2/buckets/photointel'): return {'name': 'photointel'}
        if path.endswith('/domains/managed'): return {'enabled': False}
        if path.endswith('/domains/custom'): return {'domains': []}
        if '/access/apps/' in path:
            return copy.deepcopy(next(a for a in self.apps if a['id'] == path.split('/')[-1]))
        raise AssertionError(path)

    def write(self, method, path, body):
        self.writes.append((method, path, copy.deepcopy(body)))
        if path.endswith('/access/apps'):
            item = copy.deepcopy(body)
            item.update(id='app-' + str(len(self.apps)), aud='c' * 64)
            policies = []
            for index, policy in enumerate(item['policies']):
                policy['id'] = 'policy-' + str(index)
                policies.append(policy)
            self.policies[item['id']] = policies
            self.apps.append(item)
            return copy.deepcopy(item)
        if '/policies/' in path:
            aid, pid = path.split('/')[-3], path.split('/')[-1]
            item = {**body, 'id': pid}
            self.policies[aid] = [item if p['id'] == pid else p for p in self.policies[aid]]
            return copy.deepcopy(item)
        if path.endswith('/policies'):
            aid = path.split('/')[-2]
            item = {**body, 'id': 'new-policy'}
            self.policies.setdefault(aid, []).append(item)
            return item
        if '/access/apps/' in path:
            aid = path.split('/')[-1]
            original = next(a for a in self.apps if a['id'] == aid)
            original.update(copy.deepcopy(body))
            return copy.deepcopy(original)
        raise AssertionError(path)


class SetupTests(unittest.TestCase):
    def test_plan_never_writes_cloudflare_or_gcp(self):
        api = FakeAPI()
        with patch.object(app, 'save_config') as save, patch.object(app, 'sync_runtime') as runtime:
            app.reconcile(config(), api, False)
        self.assertEqual(api.writes, [])
        save.assert_not_called()
        runtime.assert_not_called()

    def test_apply_creates_allowlisted_app_and_uses_real_audience(self):
        api, cfg = FakeAPI(), config()
        with patch.object(app, 'save_config'), patch.object(app, 'sync_runtime') as runtime:
            app.reconcile(cfg, api, True)
        self.assertEqual(cfg['access_audience'], 'c' * 64)
        runtime.assert_called_once()
        self.assertEqual(api.apps[0]['name'], 'photointel')
        self.assertEqual(api.apps[0]['destinations'], [{'type': 'public', 'uri': 'photos.migos.club'}])
        self.assertEqual(api.policies['app-0'][0]['include'], [{'email': {'email': 'rod@example.com'}}])
        self.assertFalse(any(p['decision'] == 'bypass' for p in api.policies['app-0']))

    def test_second_apply_reuses_app_and_policy_ids(self):
        api, cfg = FakeAPI(), config()
        with patch.object(app, 'save_config'), patch.object(app, 'sync_runtime'):
            app.reconcile(cfg, api, True)
            app.reconcile(cfg, api, True)
        self.assertEqual(len(api.apps), 1)
        self.assertEqual(len(api.policies['app-0']), 1)
        self.assertEqual(api.apps[0]['policies'], [{'id': 'policy-0'}])

    def test_reject_unrelated_domain_and_ambiguous_apps(self):
        unrelated = {'id': 'x', 'type': 'self_hosted', 'name': 'photointel',
                     'domain': 'private.other.org'}
        with self.assertRaises(app.SetupError):
            app.select_app([unrelated], 'photointel', ['photos.migos.club'])
        same = {**unrelated, 'domain': 'photos.migos.club'}
        with self.assertRaises(app.SetupError):
            app.select_app([same, {**same, 'id': 'y'}], 'photointel', ['photos.migos.club'])

    def test_nested_path_override_is_detected_before_mutations(self):
        api = FakeAPI()
        api.apps = [{'id': 'x', 'name': 'old-bypass', 'type': 'self_hosted',
                     'domain': 'photos.migos.club/v1/*'}]
        with self.assertRaisesRegex(app.SetupError, 'path-specific'):
            app.reconcile(config(), api, True)
        self.assertEqual(api.writes, [])

    def test_bridge_remains_path_scoped_and_uses_existing_token(self):
        api, cfg = FakeAPI(), config()
        cfg['extra_environment']['ACCESS_BRIDGE_SERVICE_TOKENS'] = '["unit.access"]'
        result = app.bridge_reconcile(cfg, api, [], ['photos.migos.club'], True)
        self.assertEqual(result['domain'], 'photos.migos.club/v1/bridge/*')
        self.assertEqual(result['policies'][0]['decision'], 'non_identity')
        self.assertEqual(result['policies'][0]['include'], [{'service_token': {'token_id': 'service-id'}}])
        self.assertEqual(result['policies'][1]['precedence'], 2)

    def test_runtime_sync_updates_auth_only_without_build_or_secret_replacement(self):
        class Success:
            returncode = 0
            stdout = '[]'
        with patch.object(app.subprocess, 'run', return_value=Success()) as run:
            app.sync_runtime(config())
        command = run.call_args_list[0].args[0]
        self.assertIn('--update-env-vars', command)
        self.assertNotIn('--env-vars-file', command)
        self.assertNotIn('--image', command)
        self.assertNotIn('build', command)

    def test_permission_denial_is_never_treated_as_missing_and_does_not_print_body(self):
        client = app.Cloudflare('a' * 32, 'PRIVATE_TOKEN')
        failure = urllib.error.HTTPError('https://api.cloudflare.com', 403, 'PRIVATE_VALUE', {}, io.BytesIO(b'PRIVATE_BODY'))
        with patch.object(app.urllib.request, 'urlopen', side_effect=failure):
            with self.assertRaises(app.SetupError) as caught:
                client.get(client.base + '/access/apps', missing=True)
        self.assertNotIn('PRIVATE', str(caught.exception))
        self.assertIn('HTTP 403', str(caught.exception))

    def test_api_pagination_collects_all_pages(self):
        client = app.Cloudflare('a' * 32, 'private')
        with patch.object(client, 'call', side_effect=[
            {'result': [{'id': '1'}], 'result_info': {'total_pages': 2}},
            {'result': [{'id': '2'}], 'result_info': {'total_pages': 2}},
        ]):
            self.assertEqual(len(client.pages(client.base + '/access/apps')), 2)


if __name__ == '__main__':
    unittest.main()
