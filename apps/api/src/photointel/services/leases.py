"""Durable, fencing-token leases compatible with transaction-mode poolers.

No session advisory lock or database connection survives an external operation.
"""

from datetime import timedelta
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.models import DurableLease, Job, utcnow


class LeaseLost(Exception):
    """A previous owner is forbidden from committing results."""


JobFence = tuple[UUID, str, int]


async def acquire_lease(
    session: AsyncSession, key: str, owner: str, seconds: int
) -> int | None:
    """Claim or reclaim one durable lease atomically in a short transaction."""
    now = utcnow()
    statement = insert(DurableLease).values(
        key=key,
        owner=owner,
        fence_token=1,
        lease_until=now + timedelta(seconds=seconds),
        updated_at=now,
    )
    result = await session.scalar(
        statement.on_conflict_do_update(
            index_elements=[DurableLease.key],
            set_={
                "owner": owner,
                "fence_token": DurableLease.fence_token + 1,
                "lease_until": now + timedelta(seconds=seconds),
                "updated_at": now,
            },
            where=(DurableLease.lease_until.is_(None))
            | (DurableLease.lease_until <= now),
        ).returning(DurableLease.fence_token)
    )
    return result


async def assert_lease(session: AsyncSession, key: str, owner: str, token: int) -> None:
    # Hold this row only during the final database commit, never during I/O.
    row = await session.scalar(
        select(DurableLease)
        .where(
            DurableLease.key == key,
            DurableLease.owner == owner,
            DurableLease.fence_token == token,
            DurableLease.lease_until > utcnow(),
        )
        .with_for_update()
    )
    if row is None:
        raise LeaseLost("Durable lease is no longer owned")


async def renew_lease(
    session: AsyncSession, key: str, owner: str, token: int, seconds: int
) -> bool:
    now = utcnow()
    return bool(
        await session.scalar(
            update(DurableLease)
            .where(
                DurableLease.key == key,
                DurableLease.owner == owner,
                DurableLease.fence_token == token,
                DurableLease.lease_until > now,
            )
            .values(lease_until=now + timedelta(seconds=seconds), updated_at=now)
            .returning(DurableLease.key)
        )
    )


async def release_lease(session: AsyncSession, key: str, owner: str, token: int) -> None:
    await session.execute(
        update(DurableLease)
        .where(
            DurableLease.key == key,
            DurableLease.owner == owner,
            DurableLease.fence_token == token,
        )
        .values(owner=None, lease_until=None, updated_at=utcnow())
    )


async def assert_job_fences(session: AsyncSession, fences: list[JobFence]) -> None:
    """Lock current owners in stable order before a short result transaction."""
    for job_id, owner, token in sorted(fences, key=lambda item: str(item[0])):
        present = await session.scalar(
            select(Job.id)
            .where(
                Job.id == job_id,
                Job.worker_id == owner,
                Job.fence_token == token,
                Job.status.in_(("preparing", "running")),
                Job.lease_until > utcnow(),
            )
            .with_for_update()
        )
        if present is None:
            raise LeaseLost("Job lease is no longer owned")
