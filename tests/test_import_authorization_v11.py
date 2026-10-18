"""Bounded authorization survives serialization, retries and policy changes."""

import hashlib
import json
from pathlib import Path

import pytest
from photointel.config import Settings
from photointel.errors import AppError
from photointel.services.import_policy import authorize_import, validate_execution


@pytest.mark.parametrize("limit,confirmed", [(100, False), (500, True), (1000, True)])
def test_authorized_limit_survives_job_payload(limit: int, confirmed: bool) -> None:
    settings = Settings(_env_file=None)
    payload = json.loads(json.dumps(authorize_import(settings, limit, confirmed)))
    assert validate_execution(settings, payload) == limit


@pytest.mark.parametrize("limit,confirmed", [(500, False), (1000, False), (10001, True)])
def test_expansion_cannot_bypass_policy(limit: int, confirmed: bool) -> None:
    with pytest.raises(AppError):
        authorize_import(Settings(_env_file=None), limit, confirmed)


def test_operator_revocation_is_explicit_not_silent_clamp() -> None:
    settings = Settings(_env_file=None)
    authorization = authorize_import(settings, 1000, True)
    limited = settings.model_copy(update={"maximum_authorized_import_limit": 500})
    with pytest.raises(AppError, match="revogada"):
        validate_execution(limited, authorization)


def test_changed_confirmation_cannot_reauthorize_retry() -> None:
    settings = Settings(_env_file=None)
    authorization = authorize_import(settings, 500, True)
    authorization["confirmed_expansion"] = False
    with pytest.raises(AppError):
        validate_execution(settings, authorization)


def test_sdk_is_pinned_licensed_and_importable() -> None:
    from pyicloud_ipd.services.photos import PhotoAsset

    root = Path(__file__).resolve().parents[1] / "packages/icloudpd-source"
    provenance = json.loads((root / "UPSTREAM.json").read_text())
    assert provenance["commit"] == "879c561240d993d748ddb4546f935090502b16d3"
    assert (root / "LICENSE.md").is_file()
    assert PhotoAsset.__name__ == "PhotoAsset"
    for name, digest in provenance["sha256"].items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest
