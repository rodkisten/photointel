"""The browser runner must never create data in a configured cloud service."""

import importlib.util
from pathlib import Path

import pytest
from sqlalchemy.engine import make_url

_spec = importlib.util.spec_from_file_location(
    "local_e2e_runner", Path(__file__).parents[1] / "infra/scripts/test-e2e-local.py"
)
assert _spec and _spec.loader
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)


def test_runner_refuses_production_configuration_before_accessing_services(tmp_path):
    with pytest.raises(ValueError, match="production"):
        runner.test_environment({"APP_ENV": "production"}, "fixture", "fixture", tmp_path)


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://private.r2.cloudflarestorage.com",
        "http://localhost@external.invalid:9000",
        "http://localhost:9000/path",
        "file:///tmp/minio",
    ],
)
def test_runner_refuses_external_or_ambiguous_storage(endpoint):
    with pytest.raises(ValueError, match="local MinIO"):
        runner.local_endpoint(endpoint)


def test_runner_isolates_test_models_and_clears_real_apple_and_modal_config(tmp_path):
    environment = runner.test_environment(
        {
            "APP_ENV": "development",
            "POSTGRES_PASSWORD": "test-only-local",
            "MINIO_ROOT_PASSWORD": "test-only-local",
            "ICLOUD_ACCOUNT": "private@example.invalid",
            "MODAL_ENDPOINT": "https://private.invalid",
            "MODAL_TOKEN": "test-only-unused",
        },
        "photointel_e2e_test",
        "photointel-e2e-test",
        tmp_path,
    )
    assert environment["APP_ENV"] == "test"
    assert environment["INFERENCE_BACKEND"] == "test"
    assert environment["ICLOUD_ENABLED"] == "false"
    assert environment["ICLOUD_ACCOUNT"] == ""
    assert environment["MODAL_ENDPOINT"] == environment["MODAL_TOKEN"] == ""
    assert environment["JOYTAG_MODEL_REVISION"] == "1" * 40
    assert environment["SIGLIP_MODEL_REVISION"] == "2" * 40
    connection = make_url(environment["DATABASE_URL"])
    assert connection.host == "127.0.0.1"
    assert connection.database == "photointel_e2e_test"
    assert environment["STORAGE_BUCKET"] == "photointel-e2e-test"
    assert environment["E2E_API_PORT"] == "18000"


def test_runner_refuses_overlapping_ports():
    with pytest.raises(ValueError, match="must differ"):
        runner.check_free_ports((18000, 18000, 14173))
