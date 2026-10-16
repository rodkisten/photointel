"""Check local S3 bootstrap never publishes a bucket or masks an access denial."""

import importlib.util
from pathlib import Path
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

SCRIPT = Path(__file__).resolve().parents[1] / "infra/scripts/init-private-bucket.py"


def helper():
    specification = importlib.util.spec_from_file_location("bucket_initializer", SCRIPT)
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def configured(monkeypatch):
    module = helper()
    client = Mock()
    monkeypatch.setenv("STORAGE_ENDPOINT", "http://local.invalid")
    monkeypatch.setenv("STORAGE_ACCESS_KEY", "private-access")
    monkeypatch.setenv("STORAGE_SECRET_KEY", "private-secret")
    monkeypatch.setenv("STORAGE_BUCKET", "private-library")
    monkeypatch.setattr(module.boto3, "client", lambda *args, **kwargs: client)
    monkeypatch.setattr(module.time, "sleep", lambda seconds: None)
    return module, client


def test_missing_local_bucket_is_created_private_after_transient_readiness(monkeypatch):
    module, client = configured(monkeypatch)
    client.list_buckets.side_effect = [
        EndpointConnectionError(endpoint_url="http://local.invalid"),
        {},
    ]
    client.head_bucket.side_effect = ClientError({"Error": {"Code": "404"}}, "HeadBucket")
    module.main()
    assert client.list_buckets.call_count == 2
    client.create_bucket.assert_called_once_with(Bucket="private-library")
    client.delete_bucket_policy.assert_called_once_with(Bucket="private-library")
    client.put_bucket_policy.assert_not_called()
    client.delete_object.assert_not_called()


def test_existing_local_bucket_only_has_public_policy_removed(monkeypatch, capsys):
    module, client = configured(monkeypatch)
    module.main()
    client.create_bucket.assert_not_called()
    client.delete_bucket_policy.assert_called_once_with(Bucket="private-library")
    output = capsys.readouterr().out
    assert "private-secret" not in output
    assert "private-access" not in output
    client.delete_object.assert_not_called()


def test_access_denial_does_not_modify_existing_bucket(monkeypatch):
    module, client = configured(monkeypatch)
    client.head_bucket.side_effect = ClientError({"Error": {"Code": "403"}}, "HeadBucket")
    with pytest.raises(SystemExit, match="access denied"):
        module.main()
    client.create_bucket.assert_not_called()
    client.delete_bucket_policy.assert_not_called()


def test_storage_unavailability_retries_bounded_without_any_write(monkeypatch):
    module, client = configured(monkeypatch)
    client.list_buckets.side_effect = EndpointConnectionError(
        endpoint_url="http://local.invalid"
    )
    with pytest.raises(SystemExit, match="unavailable"):
        module.main()
    assert client.list_buckets.call_count == 30
    client.create_bucket.assert_not_called()
    client.delete_bucket_policy.assert_not_called()
