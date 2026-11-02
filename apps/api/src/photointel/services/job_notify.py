"""Notify! Live Activities from committed job events, one per processing batch.

Never expose photo metadata, secrets, provider errors or token-bearing URLs.
The durable event cursor and activity IDs live in the existing settings table.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from collections import OrderedDict
from datetime import timedelta
from uuid import UUID, uuid4

import httpx
from sqlalchemy import func, select

from photointel.database import SessionLocal
from photointel.models import Job, JobBatch, JobEvent, Setting, utcnow

LOG = logging.getLogger("photointel.job_notify")
CURSOR = "notify:jobs:cursor"
VALID_DEVICE = re.compile(r"[A-Za-z0-9_-]{6,40}")
VALID_TOKEN = re.compile(r"[A-Za-z0-9_-]{8,128}")
VALID_ACTIVITY = re.compile(r"LA[A-Za-z0-9]{6,20}")
TERMINAL = ("completed", "failed", "cancelled")
_guard = asyncio.Lock()
_last_attempt = 0.0


def credentials() -> tuple[str, str] | None:
    if os.getenv("NOTIFY_JOB_EVENTS_ENABLED", "false").lower() != "true":
        return None
    device, token = os.getenv("NOTIFY_DEVICE_ID", ""), os.getenv("NOTIFY_TOKEN", "")
    if not VALID_DEVICE.fullmatch(device) or not VALID_TOKEN.fullmatch(token):
        LOG.warning("notify_disabled_invalid_configuration")
        return None
    return device, token


def scope_for(job_id: UUID, batch_id: UUID | None) -> str:
    return f"batch:{batch_id}" if batch_id else f"job:{job_id}"


def segments(done: int, total: int, status: str = "queued") -> dict[str, int]:
    if total == 1:
        return {"steps": 3, "step": 3 if done else 1 if status == "running" else 0}
    steps = max(2, min(20, total))
    return {"steps": steps, "step": min(steps, int(done * steps / total))}


async def send(
    client: httpx.AsyncClient, target: str, token: str, data: dict,
    *, new: bool = False, method: str = "POST",
) -> dict:
    response = await client.request(
        method, f"https://push.getnotifyapp.com/live-activity/{target}",
        params={"token": token, **({"new": "1"} if new else {})}, json=data,
    )
    response.raise_for_status()
    result = response.json()
    if not isinstance(result, dict) or result.get("success") is not True:
        raise ValueError("Notify response not confirmed")
    return result


async def send_push(
    client: httpx.AsyncClient, device: str, token: str,
    title: str, body: str, scope: str,
) -> None:
    """One grouped alert for enqueue, and one for terminal outcome."""
    response = await client.post(
        f"https://push.getnotifyapp.com/notify-json/{device}",
        params={"token": token},
        json={
            "title": title, "text": body,
            "groupType": "photointel-" + scope.replace(":", "-"),
        },
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or data.get("success") is not True:
        raise ValueError("Notify push not confirmed")


async def claim_cursor() -> tuple[str, int] | None:
    owner = uuid4().hex
    now = utcnow()
    async with SessionLocal() as session, session.begin():
        row = await session.get(Setting, CURSOR, with_for_update=True)
        if row is None:
            latest = await session.scalar(select(func.max(JobEvent.id))) or 0
            # Avoid a flood of historical notifications at first enablement.
            row = Setting(key=CURSOR, value={"cursor": max(0, latest - 200)})
            session.add(row)
            await session.flush()
        state = dict(row.value or {})
        if state.get("owner") and state.get("until", "") > now.isoformat():
            return None
        state.update(owner=owner, until=(now + timedelta(seconds=90)).isoformat())
        row.value = state
        return owner, int(state.get("cursor", 0))


async def release_cursor(owner: str, cursor: int) -> None:
    async with SessionLocal() as session, session.begin():
        row = await session.get(Setting, CURSOR, with_for_update=True)
        if row and (row.value or {}).get("owner") == owner:
            row.value = {"cursor": max(cursor, int(row.value.get("cursor", 0)))}


async def snapshot(scope: str) -> tuple[str, int, int, str]:
    async with SessionLocal() as session:
        if scope.startswith("batch:"):
            identifier = UUID(scope[6:])
            batch = await session.get(JobBatch, identifier)
            label = batch.name if batch else "Lote"
            filter_ = Job.batch_id == identifier
        else:
            identifier = UUID(scope[4:])
            job = await session.get(Job, identifier)
            label = job.job_type.replace("_", " ") if job else "Job"
            filter_ = Job.id == identifier
        counts = dict((await session.execute(
            select(Job.status, func.count()).where(filter_).group_by(Job.status)
        )).all())
    total = max(1, sum(counts.values()))
    done = sum(counts.get(value, 0) for value in TERMINAL)
    if done == total:
        status = "failed" if counts.get("failed") else (
            "cancelled" if counts.get("cancelled") else "completed"
        )
    elif counts.get("running") or counts.get("preparing"):
        status = "running"
    elif counts.get("retrying"):
        status = "retrying"
    else:
        status = "queued"
    label = re.sub(r"[\x00-\x1f]", " ", label).strip()[:44]
    return status, done, total, f"PhotoIntel · {label or 'Jobs'}"


async def deliver_scope(
    client: httpx.AsyncClient, device: str, token: str, scope: str, event_id: int,
) -> None:
    key = "notify:activity:" + scope
    async with SessionLocal() as session:
        entry = await session.get(Setting, key)
        prior = dict(entry.value or {}) if entry else {}
    if int(prior.get("event_id", 0)) >= event_id:
        return
    status, done, total, title = await snapshot(scope)
    labels = {
        "queued": "Enfileirado", "running": "Processando",
        "retrying": "Tentando novamente", "completed": "Concluído",
        "failed": "Falhou", "cancelled": "Cancelado",
    }
    body = f"{labels[status]} · {done}/{total} jobs"
    finished = status in TERMINAL
    progress = int(done * 20 / total)
    activity = prior.get("activity_id", "")
    if not isinstance(activity, str) or not VALID_ACTIVITY.fullmatch(activity):
        activity = ""
    changed = (
        status != prior.get("status") or progress != prior.get("progress")
        or not activity
    )
    if changed and not prior.get("closed"):
        data = {
            "title": title, "body": body, "trailing": f"{done}/{total}",
            "status": "running", **segments(done, total, status),
        }
        if activity:
            await send(client, activity, token, data)
        else:
            result = await send(client, device, token, data, new=True)
            activity = result.get("activityId", "")
            if not isinstance(activity, str) or not VALID_ACTIVITY.fullmatch(activity):
                raise ValueError("Notify activity ID missing")
    if not prior.get("activity_id") and not finished:
        await send_push(client, device, token, title, body, scope)
    if finished and not prior.get("closed"):
        await send(client, activity, token, {
            "title": title, "body": body, "trailing": f"{done}/{total}",
            "status": "done" if status == "completed" else "failed",
            **segments(total, total), "endsIn": None, "keepFor": 90,
        }, method="DELETE")
        await send_push(client, device, token, title, body, scope)
    async with SessionLocal() as session, session.begin():
        entry = await session.get(Setting, key, with_for_update=True)
        if entry is None:
            entry = Setting(key=key, value={})
            session.add(entry)
        entry.value = {
            "event_id": event_id, "activity_id": activity,
            "status": status, "progress": progress,
            "closed": finished or bool(prior.get("closed")),
        }


async def drain_job_notifications(*, limit: int = 200) -> dict[str, int | str]:
    """Read committed events; only one process drains each leased cursor."""
    if not 1 <= limit <= 500:
        raise ValueError("Invalid event limit")
    pair = credentials()
    if pair is None:
        return {"status": "disabled", "events": 0}
    claim = await claim_cursor()
    if claim is None:
        return {"status": "busy", "events": 0}
    owner, cursor = claim
    advanced, count = cursor, 0
    try:
        async with SessionLocal() as session:
            events = (await session.execute(
                select(JobEvent.id, Job.id, Job.batch_id, JobEvent.created_at)
                .join(Job, Job.id == JobEvent.job_id)
                .where(JobEvent.id > cursor).order_by(JobEvent.id).limit(limit)
            )).all()
        scopes: OrderedDict[str, int] = OrderedDict()
        cutoff = utcnow() - timedelta(minutes=10)
        for event_id, job_id, batch_id, created_at in events:
            scope = scope_for(job_id, batch_id)
            if created_at >= cutoff and scope not in scopes and len(scopes) >= 8:
                break
            if created_at >= cutoff:
                scopes[scope] = event_id
            advanced, count = event_id, count + 1
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(5, connect=2), follow_redirects=False,
        ) as client:
            for scope, event_id in scopes.items():
                await deliver_scope(client, pair[0], pair[1], scope, event_id)
        return {"status": "completed", "events": count}
    except asyncio.CancelledError:
        advanced = cursor
        raise
    except Exception as exc:
        advanced = cursor
        LOG.warning(
            "notify_delivery_failed", extra={"exception_type": type(exc).__name__}
        )
        return {"status": "retry", "events": 0}
    finally:
        await release_cursor(owner, advanced)


async def safe_notify() -> None:
    """Deliver the two independent providers in parallel after job commits."""
    from photointel.services.telegram_notify import safe_notify as telegram_notify

    await asyncio.gather(_safe_iphone_notify(), telegram_notify())


async def _safe_iphone_notify() -> None:
    """Never make API responses or worker jobs depend on Notify availability."""
    global _last_attempt
    if credentials() is None:
        return
    now = asyncio.get_running_loop().time()
    if _guard.locked() or now - _last_attempt < 3:
        return
    async with _guard:
        _last_attempt = asyncio.get_running_loop().time()
        try:
            async with asyncio.timeout(20):
                await drain_job_notifications()
        except Exception as exc:
            LOG.warning(
                "notify_attempt_failed", extra={"exception_type": type(exc).__name__}
            )
