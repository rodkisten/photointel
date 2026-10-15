"""Apple keyword safety can be verified without Apple accounts or a device."""

from types import SimpleNamespace

import pytest
from photointel.errors import AppError
from photointel.services.apple_sync import (
    assert_verified_mapping,
    credential_digest,
    keyword_delta,
    keywords,
    metadata_revision,
    three_way_merge,
    validate_write_receipt,
)


def test_revision_is_stable_for_unicode_order_and_duplicates() -> None:
    assert metadata_revision(["céu", "praia"]) == metadata_revision(
        [" praia ", "ce\u0301u", "céu"]
    )
    assert metadata_revision(["praia"]) != metadata_revision(["praia", "céu"])
    assert keywords(["", " praia ", "praia"]) == ["praia"]


def test_default_delta_only_adds_and_preserves_existing_keywords() -> None:
    result = keyword_delta(["Família", "Férias"], ["praia", "Família"], [], [])
    assert result["add"] == ["praia"]
    assert result["remove"] == []
    assert result["after"] == ["Família", "Férias", "praia"]


def test_unmanaged_apple_keywords_cannot_be_removed_even_with_approval() -> None:
    with pytest.raises(AppError) as error:
        keyword_delta(["Família", "praia"], [], ["Família"], ["praia"], True)
    assert error.value.code == "FORBIDDEN"


def test_managed_removal_still_requires_explicit_approval() -> None:
    with pytest.raises(AppError):
        keyword_delta(["praia"], [], ["praia"], ["praia"])
    result = keyword_delta(["praia", "Família"], [], ["praia"], ["praia"], True)
    assert result["after"] == ["Família"]


def test_three_way_merge_preserves_unrelated_user_changes() -> None:
    result = three_way_merge(["Família"], ["Família", "Férias"], ["praia"], [], [])
    assert result["after"] == ["Família", "Férias", "praia"]
    with pytest.raises(AppError) as error:
        three_way_merge(["praia"], [], [], ["praia"], ["praia"])
    assert error.value.code == "SYNC_CONFLICT"


def test_filename_similarity_or_unverified_mapping_never_authorizes_write() -> None:
    for values in [
        [],
        [SimpleNamespace(verification_status="unverified")],
        [
            SimpleNamespace(verification_status="verified"),
            SimpleNamespace(verification_status="verified"),
        ],
    ]:
        with pytest.raises(AppError) as error:
            assert_verified_mapping(values)
        assert error.value.code == "ASSET_MAPPING_AMBIGUOUS"
    verified = SimpleNamespace(verification_status="verified")
    assert assert_verified_mapping([verified]) is verified


def test_receipt_requires_before_and_after_readback() -> None:
    payload = {
        "add": ["praia"],
        "remove": [],
        "managed_keywords": [],
        "approve_removals": False,
    }
    expected = metadata_revision(["Família"])
    validate_write_receipt(payload, expected, ["Família"], ["Família", "praia"])
    with pytest.raises(AppError) as before:
        validate_write_receipt(payload, expected, ["Férias"], ["Férias", "praia"])
    assert before.value.code == "SYNC_CONFLICT"
    with pytest.raises(AppError) as after:
        validate_write_receipt(payload, expected, ["Família"], ["praia"])
    assert after.value.code == "SYNC_VERIFICATION_FAILED"


def test_hash_pepper_changes_device_credential_digest() -> None:
    assert credential_digest("bridge_a", "a") != credential_digest("bridge_a", "b")
    assert "bridge_a" not in credential_digest("bridge_a", "a")


@pytest.mark.parametrize(
    "values", [["x\nprivate"], ["x" * 256], [str(i) for i in range(201)]]
)
def test_keyword_resource_limits(values: list[str]) -> None:
    with pytest.raises(AppError):
        keywords(values)
