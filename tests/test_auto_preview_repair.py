"""Focused regressions for the safe automatic preview repair policy."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from photointel.services.preview_repair import (
    _cursor, _due, manifest_recoverable, repair_stage,
)


def test_repair_prefers_existing_private_media() -> None:
    assert repair_stage(
        ingestion_status="completed", retained=True, manifest=True,
        icloud_enabled=True, ingestion_paused=False,
    ) == "thumbnail_generate"


def test_repair_uses_apple_only_with_manifest_and_enabled_ingestion() -> None:
    baseline = dict(
        ingestion_status="completed", retained=False,
        icloud_enabled=True, ingestion_paused=False,
    )
    assert repair_stage(**baseline, manifest=True) == "media_download"
    assert repair_stage(**baseline, manifest=False) is None
    assert repair_stage(
        **{**baseline, "icloud_enabled": False}, manifest=True,
    ) is None
    assert repair_stage(
        **{**baseline, "ingestion_paused": True}, manifest=True,
    ) is None


def test_historical_failures_with_durable_source_restart_at_metadata() -> None:
    for state in ("failed", "quarantined", "downloaded", "processing", "pending"):
        assert repair_stage(
            ingestion_status=state, retained=True, source_retained=True,
            manifest=False, icloud_enabled=False, ingestion_paused=True,
        ) == "metadata_extract"


def test_historical_failures_with_valid_manifest_can_redownload_safely() -> None:
    for state in ("failed", "quarantined", "completed"):
        assert repair_stage(
            ingestion_status=state, retained=False, manifest=True,
            icloud_enabled=True, ingestion_paused=False,
        ) == "media_download"
    assert repair_stage(
        ingestion_status="failed", retained=False, manifest=True,
        icloud_enabled=False, ingestion_paused=False,
    ) is None


def test_no_source_without_valid_manifest_stays_blocked() -> None:
    assert repair_stage(
        ingestion_status="failed", retained=False, manifest=False,
        icloud_enabled=True, ingestion_paused=False,
    ) is None
    assert repair_stage(
        ingestion_status="quarantined", retained=True, source_retained=False,
        manifest=False, icloud_enabled=False, ingestion_paused=False,
    ) is None


def test_retry_exhaustion_can_be_rearmed_only_for_safe_failure_categories() -> None:
    for category in ("remote_asset_unavailable", "transient_network_error",
                     "storage_error", "rate_limited"):
        assert manifest_recoverable("quarantined", category, 5, 5)
    for category in ("authentication_required", "invalid_representation",
                     "corrupt_media", "permanent_failure", None):
        assert not manifest_recoverable("quarantined", category, 5, 5)
    assert manifest_recoverable("completed", None, 1, 5)


def test_corrupt_cursor_and_schedule_do_not_crash_sweeper() -> None:
    now = datetime.now(UTC)
    asset_id = UUID("00000000-0000-4000-8000-000000000013")
    assert _cursor(str(asset_id)) == asset_id
    assert _cursor("not-a-uuid") is None
    assert _cursor(None) is None
    assert _due(None, now)
    assert _due("broken", now)
    assert _due((now - timedelta(seconds=1)).isoformat(), now)
    assert not _due((now + timedelta(minutes=60)).isoformat(), now)
