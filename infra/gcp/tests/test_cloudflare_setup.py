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
    def test_apex_application_is_preserved_by_read_only_inspection(self):
        api = FakeAPI()
        apex = {'id': 'apex', 'name': 'photointel', 'type': 'self_hosted', 'domain': 'migos.club', 'aud': 'b' * 64}
        api.apps = [copy.deepcopy(apex)]
        app.reconcile(config(), api, False)
        self.assertEqual(api.apps, [apex])
        self.assertEqual(api.writes, [])

    def test_orphaned_bridge_selector_is_preserved_without_credential_creation(self):
        api = FakeAPI()
        api.tokens = []
        api.apps = [{'id': 'bridge-old', 'name': 'photos', 'type': 'self_hosted', 'domain': 'photos.migos.club/v1/bridge/*', 'aud': 'd' * 64}]
        api.policies['bridge-old'] = [{'id': 'orphan-policy', 'name': 'device', 'decision': 'non_identity', 'include': [{'service_token': {'token_id': 'orphan-id'}}]}]
        app.reconcile(config(), api, False)
        self.assertEqual(api.policies['bridge-old'][0]['include'], [{'service_token': {'token_id': 'orphan-id'}}])
        self.assertEqual(api.writes, [])

    def test_bridge_inspection_retains_id_and_credentials_without_mutation(self):
        api, cfg = FakeAPI(), config()
        api.apps = [{'id': 'bridge-old', 'name': 'photos', 'type': 'self_hosted', 'domain': 'photos.migos.club/v1/bridge/*', 'aud': 'd' * 64}]
        api.policies['bridge-old'] = [{'id': 'existing-policy', 'name': 'device', 'decision': 'non_identity', 'include': [{'service_token': {'token_id': 'service-id'}}]}]
        app.adopt_bridge(cfg, api, api.apps, ['photos.migos.club'])
        self.assertEqual(json.loads(cfg['extra_environment']['ACCESS_BRIDGE_SERVICE_TOKENS']), ['unit.access'])
        self.assertEqual(api.writes, [])

    def test_bridge_bypass_is_not_automatically_adopted(self):
        api = FakeAPI()
        api.apps = [{'id': 'bridge-old', 'name': 'photos', 'type': 'self_hosted',
                     'domain': 'photos.migos.club/v1/bridge/*'}]
        api.policies['bridge-old'] = [{'decision': 'bypass', 'include': [{'everyone': {}}]}]
        with self.assertRaisesRegex(app.SetupError, 'refusing to broaden'):
            app.reconcile(config(), api, True)
        self.assertEqual(api.writes, [])

    def test_plan_never_writes_cloudflare_or_gcp(self):
        api = FakeAPI()
        with patch.object(app, 'save_config') as save, patch.object(app, 'sync_runtime') as runtime:
            app.reconcile(config(), api, False)
        self.assertEqual(api.writes, [])
        save.assert_not_called()
        runtime.assert_not_called()

    def test_legacy_apply_refuses_resource_writes_after_terraform_migration(self):
        api = FakeAPI()
        with self.assertRaisesRegex(app.SetupError, 'Terraform'):
            app.reconcile(config(), api, True)
        self.assertEqual(api.writes, [])

    def test_repeated_legacy_apply_never_competes_with_terraform(self):
        api = FakeAPI()
        for _ in range(2):
            with self.assertRaisesRegex(app.SetupError, 'Terraform'):
                app.reconcile(config(), api, True)
        self.assertEqual(api.writes, [])

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

    def test_runtime_sync_requires_terraform_and_never_calls_gcloud(self):
        with patch.object(app, 'cloud_run') as run:
            with self.assertRaisesRegex(app.SetupError, 'Terraform'):
                app.sync_runtime(config())
        run.assert_not_called()

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
