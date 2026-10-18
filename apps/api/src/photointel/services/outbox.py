"""Durable Cloud Run dispatch with short claims and fenced acknowledgements.

Provider I/O is performed only after releasing the claiming transaction/connection.
A timeout can mean Google accepted the request; redelivery may start another finite
execution, whose PostgreSQL job claims remain idempotent. It cannot lose work.
"""

import asyncio
import os
import random
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import and_, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.database import SessionLocal
from photointel.models import DispatchOutbox, utcnow
from photointel.services.cloud_dispatch import (
    ALLOWED_MODES,
    DispatchConfiguration,
    GoogleJobDispatcher,
    JobMode,
)

MAXIMUM_ATTEMPTS = 8
LEASE_SECONDS = 90


@dataclass(frozen=True)
class DispatchClaim:
    id: UUID
    mode: JobMode
    owner: str
    attempt: int
    lease_until: datetime


def retry_delay(attempt: int) -> float:
    """Bounded exponential backoff with jitter, not synchronized scheduler retries."""
    base = min(900, 5 * 2 ** min(max(attempt - 1, 0), 8))
    return random.uniform(base / 2, base)  # noqa: S311 Operational jitter only.


async def enqueue_dispatch(
    session: AsyncSession, mode: JobMode, idempotency_key: str
) -> None:
    """Persist in the caller's job transaction; there is no network operation."""
    if mode not in ALLOWED_MODES or not 1 <= len(idempotency_key) <= 512:
        raise ValueError("Invalid fixed-name dispatch intent")
    await session.execute(
        insert(DispatchOutbox)
        .values(job_name=mode, idempotency_key=idempotency_key, status="pending")
        .on_conflict_do_nothing(index_elements=[DispatchOutbox.idempotency_key])
    )


async def claim_dispatches(
    session: AsyncSession, owner: str, limit: int
) -> list[DispatchClaim]:
    if not 1 <= limit <= 100 or not 1 <= len(owner) <= 128:
        raise ValueError("Invalid bounded outbox claim")
    now = utcnow()
    rows = list(
        await session.scalars(
            select(DispatchOutbox)
            .where(
                or_(
                    and_(
                        DispatchOutbox.status.in_(("pending", "retrying")),
                        or_(
                            DispatchOutbox.lease_until.is_(None),
                            DispatchOutbox.lease_until <= now,
                        ),
                    ),
                    and_(
                        DispatchOutbox.status == "claimed",
                        DispatchOutbox.lease_until <= now,
                    ),
                )
            )
            .order_by(DispatchOutbox.created_at, DispatchOutbox.id)
            .with_for_update(skip_locked=True)
            .limit(limit)
        )
    )
    claims = []
    for row in rows:
        if row.job_name not in ALLOWED_MODES or row.attempts >= MAXIMUM_ATTEMPTS:
            row.status = "failed"
            row.owner = None
            row.lease_until = None
            row.last_error = (
                "INVALID_JOB_NAME"
                if row.job_name not in ALLOWED_MODES
                else ("DISPATCH_ATTEMPTS_EXHAUSTED")
            )
            continue
        row.status = "claimed"
        row.attempts += 1
        row.owner = owner
        row.lease_until = now + timedelta(seconds=LEASE_SECONDS)
        row.updated_at = now
        claims.append(
            DispatchClaim(
                row.id, cast(JobMode, row.job_name), owner, row.attempts, row.lease_until
            )
        )
    await session.flush()
    return claims


async def acknowledge_dispatch(
    session: AsyncSession, claim: DispatchClaim, *, succeeded: bool
) -> bool:
    """An expired owner cannot acknowledge or change a newer claimant's delivery."""
    now = utcnow()
    exhausted = claim.attempt >= MAXIMUM_ATTEMPTS
    return bool(
        await session.scalar(
            update(DispatchOutbox)
            .where(
                DispatchOutbox.id == claim.id,
                DispatchOutbox.status == "claimed",
                DispatchOutbox.owner == claim.owner,
                DispatchOutbox.attempts == claim.attempt,
                DispatchOutbox.lease_until == claim.lease_until,
                DispatchOutbox.lease_until > now,
            )
            .values(
                status="dispatched"
                if succeeded
                else "failed"
                if exhausted
                else "retrying",
                owner=None,
                lease_until=None
                if succeeded or exhausted
                else (now + timedelta(seconds=retry_delay(claim.attempt))),
                last_error=None if succeeded else "CLOUD_RUN_DISPATCH_FAILED",
                updated_at=now,
            )
            .returning(DispatchOutbox.id)
        )
    )


async def drain_outbox(
    *,
    limit: int = 10,
    deadline_seconds: float = 30,
    stopped: asyncio.Event | None = None,
    dispatcher: GoogleJobDispatcher | None = None,
) -> dict[str, int | str]:
    if not 1 <= limit <= 100 or not 0 < deadline_seconds <= 300:
        raise ValueError("Invalid finite outbox drain bounds")
    if dispatcher is None:
        if os.environ.get("GCP_JOB_DISPATCH_ENABLED", "false").lower() != "true":
            return {"status": "disabled", "claimed": 0, "dispatched": 0, "retrying": 0}
        dispatcher = GoogleJobDispatcher(DispatchConfiguration.from_environment())
    if not dispatcher.configuration.enabled:
        return {"status": "disabled", "claimed": 0, "dispatched": 0, "retrying": 0}
    owner = "outbox:" + uuid4().hex
    deadline = time.monotonic() + deadline_seconds
    counts: dict[str, int | str] = {
        "status": "completed",
        "claimed": 0,
        "dispatched": 0,
        "retrying": 0,
    }
    for _ in range(limit):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or (stopped and stopped.is_set()):
            counts["status"] = "interrupted"
            break
        async with SessionLocal() as session, session.begin():
            claims = await claim_dispatches(session, owner, limit=1)
        if not claims:
            break
        claim = claims[0]
        counts["claimed"] = int(counts["claimed"]) + 1
        succeeded = False
        try:
            # The claim connection is already closed before ADC or HTTP calls.
            async with asyncio.timeout(max(0.01, remaining)):
                await dispatcher.dispatch(claim.mode)
            succeeded = True
        except asyncio.CancelledError:
            # SIGTERM/crash leaves the persisted claim for lease-expiry recovery.
            raise
        except Exception:
            # Only a stable code is persisted; provider text may contain secrets.
            pass
        async with SessionLocal() as session, session.begin():
            changed = await acknowledge_dispatch(session, claim, succeeded=succeeded)
        if changed:
            key = "dispatched" if succeeded else "retrying"
            counts[key] = int(counts[key]) + 1
    return counts
