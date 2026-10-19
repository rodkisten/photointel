"""Provenance is scoped to the installed commit and cannot disclose arbitrary JSON."""

import json

from photointel.services.release import get_release_manifest

SHA = "a" * 40


def test_missing_release_is_explicitly_unverified(tmp_path, monkeypatch):
    monkeypatch.setenv("PHOTOINTEL_RELEASE_MANIFEST", str(tmp_path / "missing.json"))
    monkeypatch.delenv("RELEASE_GIT_SHA", raising=False)
    result = get_release_manifest()
    assert result["git_sha"] is None
    assert result["provenance_status"] == "unidentified"
    assert result["validation_status"] == "unverified"


def test_release_discards_secrets_and_other_commit_evidence(tmp_path, monkeypatch):
    manifest = tmp_path / "release.json"
    manifest.write_text(
        json.dumps(
            {
                "git_sha": SHA,
                "database_password": "never-return-this-secret",
                "models": {"joytag": {"revision": "b" * 40, "token": "private"}},
                "test_results": [
                    {
                        "name": "old suite",
                        "git_sha": "c" * 40,
                        "status": "passed",
                        "reference": "reports/old.json",
                    },
                    {
                        "name": "current suite",
                        "git_sha": SHA,
                        "status": "passed",
                        "reference": "reports/current.json",
                        "secret": "private",
                    },
                    {
                        "name": "bad URL",
                        "git_sha": SHA,
                        "status": "passed",
                        "reference": "https://example.com/?token=private",
                    },
                ],
            }
        )
    )
    monkeypatch.setenv("PHOTOINTEL_RELEASE_MANIFEST", str(manifest))
    result = get_release_manifest()
    assert result["git_sha"] == SHA
    assert result["models"]["joytag"] == {"revision": "b" * 40}
    assert result["test_results"] == [
        {
            "name": "current suite",
            "git_sha": SHA,
            "status": "passed",
            "reference": "reports/current.json",
        }
    ]
    assert "private" not in json.dumps(result)
    assert "never-return-this-secret" not in json.dumps(result)


def test_corrupt_or_oversized_release_does_not_claim_validation(tmp_path, monkeypatch):
    manifest = tmp_path / "release.json"
    monkeypatch.setenv("PHOTOINTEL_RELEASE_MANIFEST", str(manifest))
    monkeypatch.delenv("RELEASE_GIT_SHA", raising=False)
    for value in ("{invalid", " " * 65_537, "[]"):
        manifest.write_text(value)
        assert get_release_manifest()["validation_status"] == "unverified"
