"""Portable Pyto client tests never claim iOS hardware or native write verification."""

import json
from datetime import UTC, datetime

import pytest

from bridges.pyto.bridge import (
    BridgeError,
    Client,
    PhotoKitReader,
    UnavailableKeywordWriter,
    main,
    revision,
    safe_keyword_plan,
)


@pytest.mark.parametrize(
    "url",
    [
        "http://api.example.com",
        "https://user:secret@example.com",
        "https://api.example.com/v1",
        "https://api.example.com?a=x",
    ],
)
def test_bridge_transport_rejects_unsafe_origins(url: str) -> None:
    with pytest.raises(BridgeError):
        Client(url)
    assert Client("https://photos.example.com").base_url == "https://photos.example.com"


def test_doctor_reports_unavailable_without_photokit(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["doctor"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is True
    caps = result["result"]["capabilities"]
    assert caps["keywords_write"] is False
    assert caps["keywords_read"] is False


def test_native_keyword_adapter_never_fabricates_success() -> None:
    adapter = UnavailableKeywordWriter()
    with pytest.raises(BridgeError) as error:
        adapter.apply_delta("device-local-id", ["praia"], [])
    assert error.value.code == "PHOTOKIT_WRITE_UNAVAILABLE"
    with pytest.raises(BridgeError):
        adapter.read("device-local-id")


def test_keyword_plan_requires_approval_and_read_before_write() -> None:
    operation = {
        "status": "claimed",
        "approved_at": datetime.now(UTC).isoformat(),
        "expected_revision": revision(["Família"]),
        "desired_revision": revision(["Família", "praia"]),
        "payload": {
            "add": ["praia"],
            "remove": [],
            "managed_keywords": [],
            "approve_removals": False,
        },
    }
    assert safe_keyword_plan(operation, ["Família"])["after"] == ["Família", "praia"]
    with pytest.raises(BridgeError) as error:
        safe_keyword_plan(operation, ["Família", "Férias"])
    assert error.value.code == "SYNC_CONFLICT"
    operation["approved_at"] = None
    with pytest.raises(BridgeError):
        safe_keyword_plan(operation, ["Família"])


def test_photo_inventory_requires_authorization() -> None:
    reader = PhotoKitReader()
    if reader.authorization() == "unavailable":
        with pytest.raises(BridgeError) as error:
            reader.inventory(0, 50, {})
        assert error.value.code == "PHOTOKIT_PERMISSION_DENIED"


def test_transport_retries_only_idempotent_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = []

    def request(method: str, path: str, body: object) -> dict[str, bool]:
        attempts.append(path)
        if len(attempts) < 3:
            raise BridgeError("BACKEND_UNAVAILABLE", "transient fixture")
        return {"ok": True}

    client = Client("https://photos.example.com")
    monkeypatch.setattr(client, "_request_once", request)
    monkeypatch.setattr("bridges.pyto.bridge.time.sleep", lambda delay: None)
    assert client.request("GET", "/v1/bridge/status") == {"ok": True}
    assert len(attempts) == 3
    attempts.clear()
    with pytest.raises(BridgeError):
        client.request("POST", "/v1/bridge/enroll", {})
    assert len(attempts) == 1


def test_keyword_symbol_presence_cannot_enable_unverified_native_writes() -> None:
    from bridges.pyto.bridge import keyword_api_probe

    probe = keyword_api_probe()
    assert probe["documented_ios_version"] == "27.0"
    assert probe["native_write_verified"] is False
    caps = PhotoKitReader().capabilities()
    assert caps["keywords_write"] is False
    assert caps["keywords_read"] is False


def test_photokit_checks_explicit_read_write_grant() -> None:
    from unittest.mock import Mock

    reader = PhotoKitReader()
    reader.library_class = Mock()
    reader.library_class.authorizationStatusForAccessLevel_.return_value = 1
    assert reader.authorization() == "restricted"
    reader.library_class.authorizationStatusForAccessLevel_.assert_called_once_with(2)

    reader.library_class.authorizationStatusForAccessLevel_.return_value = 3
    assert reader.authorization() == "authorized"
    assert reader.capabilities()["photo_access_complete"] is True
    reader.library_class.authorizationStatusForAccessLevel_.return_value = 4
    assert reader.authorization() == "limited"
    assert reader.capabilities()["photo_access_complete"] is False


def test_photokit_permission_request_explains_nonpromptable_states() -> None:
    from unittest.mock import Mock

    reader = PhotoKitReader()
    reader.library_class = Mock()
    reader.usage_description_present = True

    for status, expected_code in (
        (1, "PHOTOKIT_RESTRICTED"),
        (2, "PHOTOKIT_PERMISSION_DENIED"),
    ):
        reader.library_class.authorizationStatusForAccessLevel_.return_value = status
        with pytest.raises(BridgeError) as caught:
            reader.request_authorization()
        assert caught.value.code == expected_code

    reader.library_class.authorizationStatusForAccessLevel_.return_value = 3
    assert reader.request_authorization() == "authorized"
    reader.library_class.requestAuthorizationForAccessLevel_handler_.assert_not_called()


def test_photokit_prevents_crash_when_usage_description_is_missing() -> None:
    from unittest.mock import Mock

    reader = PhotoKitReader()
    reader.library_class = Mock()
    reader.library_class.authorizationStatusForAccessLevel_.return_value = 0
    reader.usage_description_present = False
    with pytest.raises(BridgeError) as caught:
        reader.request_authorization()
    assert caught.value.code == "PHOTOKIT_USAGE_DESCRIPTION_MISSING"
    reader.library_class.requestAuthorizationForAccessLevel_handler_.assert_not_called()
