"""Real PostgreSQL dispatch ownership, crash recovery and external-I/O boundary."""

from collections.abc import AsyncIterator
from datetime import timedelta
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from photointel.database import SessionLocal, engine
from photointel.models import DispatchOutbox, utcnow
from photointel.services.cloud_dispatch import DispatchConfiguration, GoogleJobDispatcher
from photointel.services.outbox import (
    acknowledge_dispatch,
    claim_dispatches,
    drain_outbox,
    enqueue_dispatch,
)
from sqlalchemy import delete, func, select, update

pytestmark = pytest.mark.integration


@pytest.fixture
async def dispatch_intent() -> AsyncIterator[DispatchOutbox]:
    async with SessionLocal() as session:
        row = DispatchOutbox(
            job_name="worker",
            idempotency_key=f"outbox-test:{uuid4()}",
            created_at=utcnow() - timedelta(days=365),
        )
        session.add(row)
        await session.commit()
    try:
        yield row
    finally:
        async with SessionLocal() as session:
            await session.execute(
                delete(DispatchOutbox).where(DispatchOutbox.id == row.id)
            )
            await session.commit()


async def test_two_dispatchers_cannot_claim_same_row(dispatch_intent) -> None:
    async with SessionLocal() as first, SessionLocal() as second:
        first_claims = await claim_dispatches(first, "first-owner", 1)
        assert first_claims[0].id == dispatch_intent.id
        second_claims = await claim_dispatches(second, "second-owner", 1)
        assert all(claim.id != dispatch_intent.id for claim in second_claims)
        await second.rollback()
        await first.rollback()


async def test_dispatch_crash_expired_lease_cannot_ack_newer_owner(
    dispatch_intent,
) -> None:
    async with SessionLocal() as session:
        old = (await claim_dispatches(session, "crashed-owner", 1))[0]
        await session.commit()
        await session.execute(
            update(DispatchOutbox)
            .where(DispatchOutbox.id == old.id)
            .values(lease_until=utcnow() - timedelta(seconds=1))
        )
        await session.commit()
    async with SessionLocal() as session:
        current = (await claim_dispatches(session, "recovered-owner", 1))[0]
        await session.commit()
        assert current.id == old.id
        assert current.attempt == old.attempt + 1
        assert not await acknowledge_dispatch(session, old, succeeded=True)
        assert await acknowledge_dispatch(session, current, succeeded=True)
        await session.commit()


async def test_external_dispatch_has_no_open_claim_transaction(
    dispatch_intent, monkeypatch: pytest.MonkeyPatch
) -> None:
    dispatcher = GoogleJobDispatcher(
        DispatchConfiguration("photointel-test", "us-central1", enabled=True)
    )

    async def external_call(_mode: str) -> str:
        # Observe committed status and acquire row lock through a different connection.
        checked_out = getattr(engine.pool, "checkedout", lambda: 0)
        assert checked_out() == 0, "External dispatch retained a pooled SQL connection"
        async with SessionLocal() as observer:
            row = await observer.scalar(
                select(DispatchOutbox)
                .where(DispatchOutbox.id == dispatch_intent.id)
                .with_for_update(nowait=True)
            )
            assert row.status == "claimed"
            await observer.rollback()
        return "projects/photointel-test/locations/us-central1/operations/test"

    monkeypatch.setattr(dispatcher, "dispatch", external_call)
    result = await drain_outbox(limit=1, dispatcher=dispatcher)
    assert result["dispatched"] == 1
    async with SessionLocal() as session:
        row = await session.get(DispatchOutbox, dispatch_intent.id)
        assert row.status == "dispatched"
        assert row.owner is None


async def test_failure_records_backoff_without_immediate_redelivery(
    dispatch_intent,
) -> None:
    dispatcher = GoogleJobDispatcher(
        DispatchConfiguration("photointel-test", "us-central1", enabled=True)
    )
    dispatcher.dispatch = AsyncMock(side_effect=OSError("private-provider-detail"))
    result = await drain_outbox(limit=1, dispatcher=dispatcher)
    assert result["retrying"] == 1
    async with SessionLocal() as session:
        row = await session.get(DispatchOutbox, dispatch_intent.id)
        assert row.status == "retrying"
        assert row.lease_until > utcnow()
        assert row.last_error == "CLOUD_RUN_DISPATCH_FAILED"
        claims = await claim_dispatches(session, "too-early", 1)
        assert all(claim.id != dispatch_intent.id for claim in claims)
        await session.rollback()


async def test_duplicate_dispatch_intent_is_idempotent() -> None:
    key = f"outbox-duplicate-test:{uuid4()}"
    ids: list[UUID] = []
    try:
        async with SessionLocal() as session:
            await enqueue_dispatch(session, "worker", key)
            await enqueue_dispatch(session, "worker", key)
            await session.commit()
            count = await session.scalar(
                select(func.count())
                .select_from(DispatchOutbox)
                .where(DispatchOutbox.idempotency_key == key)
            )
            ids = list(
                await session.scalars(
                    select(DispatchOutbox.id).where(DispatchOutbox.idempotency_key == key)
                )
            )
            assert count == 1
    finally:
        if ids:
            async with SessionLocal() as session:
                await session.execute(
                    delete(DispatchOutbox).where(DispatchOutbox.id.in_(ids))
                )
                await session.commit()
