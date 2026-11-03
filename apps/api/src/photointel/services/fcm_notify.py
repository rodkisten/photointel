"""Firebase Cloud Messaging for persisted job events.

One private, replaceable push per batch or standalone job. Never include photo
metadata, provider error text, access credentials or full diagnostic payloads.
All calls happen after the job transaction commits and may fail independently.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from collections import OrderedDict
from datetime import timedelta
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import google.auth
import httpx
from google.auth.transport.requests import Request as GoogleRequest
from sqlalchemy import func, select

from photointel.config import get_settings
from photointel.database import SessionLocal
from photointel.models import Job, JobBatch, JobEvent, Setting, utcnow

LOG = logging.getLogger("photointel.fcm_notify")
CURSOR = "fcm:jobs:cursor:v1"
PREFIX = "fcm:device:"
SENT_PREFIX = "fcm:sent:"
SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
STATES = frozenset(("queued", "preparing", "running", "retrying", "completed", "failed", "cancelled"))
TERMINAL = frozenset(("completed", "failed", "cancelled"))
PROJECT_RE = re.compile(r"[a-z][a-z0-9-]{4,62}")
FID_RE = re.compile(r"[A-Za-z0-9_-]{16,256}")
_guard = asyncio.Lock()


def configured() -> bool:
    return os.getenv("FCM_JOB_EVENTS_ENABLED", "false").lower() == "true" and bool(project_id())


def project_id() -> str | None:
    value = os.getenv("FCM_PROJECT_ID", "").strip()
    return value if PROJECT_RE.fullmatch(value) else None


def device_key(fid: str) -> str:
    # Never put Firebase installation identifiers in Setting keys or logs.
    return PREFIX + hashlib.sha256(fid.encode("utf-8")).hexdigest()


def scope_for(job: Job) -> str:
    return f"batch:{job.batch_id}" if job.batch_id else f"job:{job.id}"


def allowed_emails() -> set[str]:
    settings = get_settings()
    if settings.auth_mode == "local" and not settings.is_production:
        return {settings.local_identity_email.casefold()}
    return {email.casefold() for email in settings.access_allowed_emails}


async def active_installations() -> list[tuple[str, str]]:
    """Bound sends and exclude revoked or stale Cloudflare Access identities."""
    cutoff = utcnow() - timedelta(days=45)
    async with SessionLocal() as session:
        rows = (await session.scalars(
            select(Setting).where(
                Setting.key.like(PREFIX + "%"),
                Setting.updated_at >= cutoff,
            ).order_by(Setting.updated_at.desc()).limit(64)
        )).all()
    allowed = allowed_emails()
    installations: list[tuple[str, str]] = []
    for row in rows:
        value = row.value if isinstance(row.value, dict) else {}
        fid, email = value.get("installation_id"), value.get("email")
        if (isinstance(fid, str) and FID_RE.fullmatch(fid) and
                isinstance(email, str) and email.casefold() in allowed):
            installations.append((row.key, fid))
    return installations


def _access_token() -> str:
    """Cloud Run ADC: no Firebase service-account JSON stored in the app."""
    credentials, _ = google.auth.default(scopes=[SCOPE])
    if not credentials.valid:
        credentials.refresh(GoogleRequest())
    if not credentials.token:
        raise RuntimeError("FCM ADC access token unavailable")
    return str(credentials.token)


def notification_payload(
    fid: str, *, title: str, body: str, status: str, scope: str,
    job_id: str, event_id: int, done: int, total: int,
) -> dict:
    settings = get_settings()
    origin = settings.frontend_origin.rstrip("/")
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path not in ("", "/"):
        raise ValueError("FRONTEND_ORIGIN must be an HTTPS origin for FCM")
    # IDs are created server-side, never URLs received from a client or JobEvent.
    url = origin + "/jobs?" + ("batch=" if scope.startswith("batch:") else "job=") + scope.split(":", 1)[1]
    tag = "photointel-" + scope.replace(":", "-")
    return {
        "message": {
            "token": fid,
            "notification": {"title": title, "body": body},
            "data": {
                "kind": "job_status", "status": status, "scope": scope,
                "job_id": job_id, "event_id": str(event_id),
                "done": str(done), "total": str(total), "url": url,
            },
            "webpush": {
                "headers": {
                    "TTL": "3600",
                    "Urgency": "high" if status in ("failed", "completed") else "normal",
                },
                "notification": {
                    "title": title, "body": body, "tag": tag,
                    "icon": origin + "/icon-192.png",
                    "badge": origin + "/icon-192.png",
                    "renotify": False,
                },
                "fcm_options": {"link": url},
            },
        }
    }


async def send_message(
    client: httpx.AsyncClient, fid: str, *,
    title: str, body: str, status: str, scope: str,
    job_id: str, event_id: int, done: int, total: int,
) -> None:
    project = project_id()
    if not project:
        raise ValueError("FCM_PROJECT_ID is missing or invalid")
    token = await asyncio.to_thread(_access_token)
    response = await client.post(
        f"https://fcm.googleapis.com/v1/projects/{project}/messages:send",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        json=notification_payload(
            fid, title=title, body=body, status=status, scope=scope,
            job_id=job_id, event_id=event_id, done=done, total=total,
        ),
    )
    # Never print the response body; it can contain sensitive provider details.
    response.raise_for_status()


async def snapshot(job: Job) -> tuple[str, int, int, int, str]:
    if job.batch_id is None:
        status = job.status if job.status in STATES else "running"
        return status, int(status in TERMINAL), 1, int(status == "failed"), (
            "PhotoIntel · " + job.job_type.replace("_", " ")[:42]
        )
    async with SessionLocal() as session:
        counts = dict((await session.execute(
            select(Job.status, func.count()).where(Job.batch_id == job.batch_id)
            .group_by(Job.status)
        )).all())
    total = max(1, sum(counts.values()))
    done = sum(counts.get(item, 0) for item in TERMINAL)
    failures = counts.get("failed", 0)
    if done == total:
        status = "failed" if failures else ("cancelled" if counts.get("cancelled") else "completed")
    elif counts.get("retrying"):
        status = "retrying"
    elif counts.get("running") or counts.get("preparing"):
        status = "running"
    else:
        status = "queued"
    return status, done, total, failures, "PhotoIntel · Processamento de fotos"


def summary(status: str, done: int, total: int, failures: int) -> str:
    labels = {
        "queued": "Na fila", "preparing": "Preparando", "running": "Processando",
        "retrying": "Tentando novamente", "completed": "Concluído",
        "failed": "Falhou", "cancelled": "Cancelado",
    }
    result = f"{labels.get(status, 'Atualização')} · {done}/{total} jobs"
    if failures and status != "failed":
        result += f" · {failures} falha(s)"
    return result


def signature(status: str, done: int, total: int, failures: int) -> str:
    """At most 10 progress pushes per batch, plus transitions and failures."""
    bucket = int(done * 10 / max(total, 1))
    return f"{status}:{bucket}:{int(failures > 0)}"


async def claim_cursor() -> tuple[str, int] | None:
    owner, now = uuid4().hex, utcnow()
    async with SessionLocal() as session, session.begin():
        row = await session.get(Setting, CURSOR, with_for_update=True)
        if row is None:
            latest = int(await session.scalar(select(func.max(JobEvent.id))) or 0)
            recent = await session.scalar(select(func.min(JobEvent.id)).where(
                JobEvent.created_at >= now - timedelta(minutes=2)
            ))
            cursor = max(0, latest - 40, int(recent) - 1) if recent else latest
            row = Setting(key=CURSOR, value={"cursor": cursor})
            session.add(row)
            await session.flush()
        state = dict(row.value or {})
        if state.get("owner") and state.get("until", "") > now.isoformat():
            return None
        cursor = int(state.get("cursor", 0))
        row.value = {
            "cursor": cursor, "owner": owner,
            "until": (now + timedelta(seconds=90)).isoformat(),
        }
        return owner, cursor


async def release_cursor(owner: str, cursor: int) -> None:
    async with SessionLocal() as session, session.begin():
        row = await session.get(Setting, CURSOR, with_for_update=True)
        if row and (row.value or {}).get("owner") == owner:
            row.value = {"cursor": max(cursor, int(row.value.get("cursor", 0)))}


async def last_sent(scope: str) -> dict:
    async with SessionLocal() as session:
        row = await session.get(Setting, SENT_PREFIX + scope)
        return dict(row.value or {}) if row else {}


async def record_sent(scope: str, event_id: int, fingerprint: str) -> None:
    async with SessionLocal() as session, session.begin():
        row = await session.get(Setting, SENT_PREFIX + scope, with_for_update=True)
        data = {"event_id": event_id, "signature": fingerprint}
        if row is None:
            session.add(Setting(key=SENT_PREFIX + scope, value=data))
        elif event_id >= int((row.value or {}).get("event_id", 0)):
            row.value = data


async def drain(*, limit: int = 160) -> dict[str, int | str]:
    if not 1 <= limit <= 200:
        raise ValueError("Invalid event limit")
    if not configured():
        return {"status": "disabled", "events": 0}
    devices = await active_installations()
    if not devices:
        return {"status": "no_devices", "events": 0}
    claim = await claim_cursor()
    if claim is None:
        return {"status": "busy", "events": 0}
    owner, cursor = claim
    advanced, count = cursor, 0
    try:
        async with SessionLocal() as session:
            events = (await session.execute(
                select(JobEvent, Job).join(Job, Job.id == JobEvent.job_id)
                .where(JobEvent.id > cursor).order_by(JobEvent.id).limit(limit)
            )).all()
        grouped: OrderedDict[str, tuple[JobEvent, Job]] = OrderedDict()
        for event, job in events:
            if event.status in STATES:
                key = scope_for(job)
                if key not in grouped and len(grouped) >= 8:
                    break
                grouped[key] = (event, job)
            advanced, count = event.id, count + 1
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(7, connect=2), follow_redirects=False,
        ) as client:
            for scope, (event, job) in grouped.items():
                status, done, total, failures, title = await snapshot(job)
                fingerprint = signature(status, done, total, failures)
                prior = await last_sent(scope)
                if prior.get("signature") == fingerprint:
                    continue
                for _, fid in devices:
                    await send_message(
                        client, fid, title=title, body=summary(status, done, total, failures),
                        status=status, scope=scope, job_id=str(job.id),
                        event_id=event.id, done=done, total=total,
                    )
                # Retry after failure without losing the durable event cursor.
                await record_sent(scope, event.id, fingerprint)
        return {"status": "completed", "events": count, "pushes": len(grouped)}
    except asyncio.CancelledError:
        advanced = cursor
        raise
    except Exception as exc:
        advanced = cursor
        LOG.warning("fcm_delivery_failed", extra={"exception_type": type(exc).__name__})
        return {"status": "retry", "events": 0}
    finally:
        await release_cursor(owner, advanced)


async def safe_notify() -> None:
    """Best-effort and independent of Telegram, Notify! and job execution."""
    if not configured() or _guard.locked():
        return
    async with _guard:
        try:
            async with asyncio.timeout(30):
                for _ in range(3):
                    outcome = await drain()
                    if outcome.get("status") != "completed" or not outcome.get("events"):
                        break
        except Exception as exc:
            LOG.warning("fcm_attempt_failed", extra={"exception_type": type(exc).__name__})
