"""Focused regressions for the safe automatic preview repair policy."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from photointel.services.preview_repair import _cursor, _due, repair_stage


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


def test_repair_never_restarts_blocked_sources_automatically() -> None:
    for state in ("failed", "quarantined", "pending", "processing"):
        assert repair_stage(
            ingestion_status=state, retained=True, manifest=True,
            icloud_enabled=True, ingestion_paused=False,
        ) is None


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
