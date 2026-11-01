"""Regression tests for backend jobs."""

from uuid import uuid4

from sqlalchemy.dialects import postgresql

from photointel.errors import AppError
from photointel.services.jobs import _batch_lock_statement
from photointel.services.worker import _is_session_lease_contention


def test_icloud_session_is_deferred_only_for_icloud_jobs() -> None:
    occupied = AppError("RATE_LIMITED", "Session occupied", 503)
    assert _is_session_lease_contention(occupied, "media_download")
    assert _is_session_lease_contention(occupied, "icloud_discovery")
    assert not _is_session_lease_contention(occupied, "metadata_extract")
    assert not _is_session_lease_contention(
        AppError("ICLOUD_RATE_LIMITED", "Provider throttle", 503), "media_download"
    )


def test_batch_lock_does_not_block_fk_key_share() -> None:
    sql = str(_batch_lock_statement(uuid4()).compile(dialect=postgresql.dialect()))
    assert "FOR NO KEY UPDATE" in sql
    assert "FOR UPDATE" not in sql
