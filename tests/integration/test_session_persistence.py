"""Actual PostgreSQL CAS/lease ownership, independent of an Apple session."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from photointel.config import Settings
from photointel.database import SessionLocal
from photointel.errors import AppError
from photointel.models import SessionState
from photointel.services.session_store import SessionRepository, session_scope
from sqlalchemy import delete, select, update

pytestmark = pytest.mark.integration


async def test_session_snapshot_compare_swap_fences_expired_owner():
    configuration = Settings(
        app_env="test",
        icloud_account=f"fixture-{uuid4()}@invalid.test",
        icloud_library="PrimarySync",
    )
    repository = SessionRepository(configuration)
    scope = session_scope(configuration)
    try:
        results = await asyncio.gather(
            repository.claim(), repository.claim(), return_exceptions=True
        )
        leases = [result for result in results if not isinstance(result, BaseException)]
        failures = [result for result in results if isinstance(result, AppError)]
        assert len(leases) == len(failures) == 1
        old = leases[0]
        async with SessionLocal() as db, db.begin():
            await db.execute(
                update(SessionState)
                .where(SessionState.scope_key == scope)
                .values(lease_until=datetime.now(UTC) - timedelta(seconds=1))
            )
        new = await repository.claim()
        assert new.token > old.token
        with pytest.raises(AppError) as error:
            await repository.publish(old, "sessions/stale.json", "a" * 64)
        assert error.value.code == "SYNC_CONFLICT"
        await repository.publish(new, "sessions/current.json", "b" * 64)
        await repository.release(old)  # Stale cleanup must not release the newer lease.
        assert await repository.heartbeat(new)
        async with SessionLocal() as db:
            row = await db.scalar(
                select(SessionState).where(SessionState.scope_key == scope)
            )
            assert row is not None
            assert row.object_key == "sessions/current.json"
            assert row.generation == 1
            assert row.lease_owner == new.owner
        await repository.release(new)
        revoked = await repository.claim()
        await repository.revoke(revoked)
        await repository.release(revoked)
        missing = await repository.claim()
        assert missing.object_key is None
        assert missing.generation == 2
        await repository.release(missing)
    finally:
        async with SessionLocal() as db, db.begin():
            await db.execute(delete(SessionState).where(SessionState.scope_key == scope))
