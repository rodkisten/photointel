"""Telegram notifications from committed PhotoIntel job events, via xtelegram.

Only bounded, sanitized technical diagnostics leave the API. Complete tracebacks,
exception messages and local variables remain in the exact Sentry event.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from collections import OrderedDict
from datetime import timedelta
from urllib.parse import quote, urlsplit
from uuid import uuid4

import httpx
from sqlalchemy import func, select

from photointel.database import SessionLocal
from photointel.models import Job, JobBatch, JobEvent, Setting, utcnow
from photointel.observability import valid_correlation
from photointel.sentry_observability import event_id

LOG = logging.getLogger("photointel.telegram_notify")
CURSOR = "telegram:jobs:cursor:v1"
STATES = {"queued", "preparing", "running", "retrying", "completed", "failed", "cancelled"}
ERROR_STATES = {"failed", "retrying"}
STATUS = {
    "queued": ("📥", "Enfileirado"),
    "preparing": ("🛠️", "Preparando"),
    "running": ("🔄", "Em execução"),
    "retrying": ("⚠️", "Tentando novamente"),
    "completed": ("✅", "Concluído"),
    "failed": ("❌", "Falhou"),
    "cancelled": ("🛑", "Cancelado"),
}
CHAT = re.compile(r"(?:-?\d+(?::[1-9]\d*)?|@[a-zA-Z0-9_]{1,64})\Z")
CODE = re.compile(r"[A-Za-z_][A-Za-z0-9_.:-]{0,120}\Z")
STACK = re.compile(r"[a-zA-Z0-9_./:-]{1,180}\Z")
_guard = asyncio.Lock()
_last_attempt = 0.0


def credentials() -> tuple[str, str, str] | None:
    if os.getenv("TELEGRAM_JOB_EVENTS_ENABLED", "false").lower() != "true":
        return None
    endpoint = os.getenv("TELEGRAM_NOTIFICATION_URL", "").strip()
    token = os.getenv("TELEGRAM_NOTIFICATION_API_TOKEN", "").strip()
    chat = os.getenv("TELEGRAM_NOTIFICATION_CHAT_ID", "").strip()
    p = urlsplit(endpoint)
    if (p.scheme != "https" or not p.hostname or p.username or p.password
            or p.port or p.query or p.fragment or p.path != "/notifications/send"
            or not 20 <= len(token) <= 512 or not CHAT.fullmatch(chat)):
        LOG.warning("telegram_notification_config_invalid")
        return None
    return endpoint, token, chat


def md(value: object) -> str:
    specials = "\\_*[]()~" + chr(96) + ">#+-=|{}.!"
    return "".join("\\" + c if c in specials else c for c in str(value))


def safe_code(value: object) -> str:
    return value if isinstance(value, str) and CODE.fullmatch(value) else ""


def safe_urls(job: Job, sentry: str | None, correlation: str) -> list[list[dict[str, str]]]:
    origin = os.getenv("API_ORIGIN", "https://photos.migos.club").rstrip("/")
    frontend = os.getenv("FRONTEND_ORIGIN", "https://photos.migos.club").rstrip("/")
    links: list[list[dict[str, str]]] = []
    if urlsplit(frontend).scheme == "https":
        links.append([{"text": "📋 Jobs", "url": frontend + "/jobs"}])
    if sentry and urlsplit(origin).scheme == "https":
        links.append([{
            "text": "🧨 Erro exato · Sentry",
            "url": origin + "/v1/observability/sentry-events/" + sentry,
        }])
    project = os.getenv("GCP_PROJECT_ID", "photointel")
    if not re.fullmatch(r"[a-z][a-z0-9:-]{3,62}", project):
        project = "photointel"
    name = "photointel-discover" if job.job_type == "icloud_discovery" else "photointel-worker"
    query = ('resource.type="cloud_run_job"\nresource.labels.job_name="' +
             name + '"\n(SEARCH("' + str(job.id) + '") OR SEARCH("' + correlation + '"))')
    links.append([{
        "text": "🪵 Logs completos · GCP",
        "url": "https://console.cloud.google.com/logs/query;query=" +
               quote(query, safe="") + ";duration=P7D?project=" + project,
    }])
    return links[:3]


def diagnostic(job: Job, event: JobEvent) -> list[str]:
    details = job.error_details if isinstance(job.error_details, dict) else {}
    payload = event.payload if isinstance(event.payload, dict) else {}
    correlation = valid_correlation(job.payload.get("correlation_id")) or str(job.id)
    lines = [
        "Código: " + (safe_code(payload.get("error_code")) or safe_code(job.error_code) or "INTERNAL_ERROR"),
        "Exceção: " + (safe_code(payload.get("exception_type")) or
                         safe_code(details.get("exception_type")) or "Não registrada"),
        "Tentativa: " + str(job.attempts) + "/" + str(job.maximum_attempts),
        "Job: " + str(job.id),
        "Correlation ID: " + correlation,
    ]
    sentry = event_id(payload.get("sentry_event_id") or details.get("sentry_event_id"))
    if sentry:
        lines.append("Sentry event: " + sentry)
    stack = payload.get("traceback") or details.get("traceback")
    if isinstance(stack, list):
        lines.extend(frame for frame in stack[:32] if isinstance(frame, str) and STACK.fullmatch(frame))
    return lines


def format_message(
    job: Job, event: JobEvent, batch: JobBatch | None = None,
    counts: dict[str, int] | None = None, grouped_events: int = 1,
) -> tuple[str, list[list[dict[str, str]]]]:
    icon, label = STATUS[event.status]
    payload = event.payload if isinstance(event.payload, dict) else {}
    details = job.error_details if isinstance(job.error_details, dict) else {}
    sentry = event_id(payload.get("sentry_event_id") or details.get("sentry_event_id"))
    correlation = valid_correlation(job.payload.get("correlation_id")) or str(job.id)
    lines = [
        icon + " *PhotoIntel · " + md(label) + "*",
        "⚙️ *Etapa:* " + md(job.job_type.replace("_", " ")),
        "🔖 *Job:* " + md(str(job.id)),
    ]
    if batch:
        name = re.sub(r"[\x00-\x1f]", " ", batch.name or "")[:64]
        lines.append("📦 *Lote:* " + md(name or "Processamento"))
        lines.append("🧩 *Lote ID:* " + md(str(batch.id)))
    if counts:
        total = sum(counts.values())
        done = sum(counts.get(status, 0) for status in ("completed", "failed", "cancelled"))
        lines.append("📊 *Progresso:* " + md(str(done) + "/" + str(total) + " jobs"))
        lines.append(md(
            "Fila " + str(counts.get("queued", 0)) +
            " · Ativos " + str(counts.get("running", 0) + counts.get("preparing", 0)) +
            " · Concluídos " + str(counts.get("completed", 0)) +
            " · Falhas " + str(counts.get("failed", 0)) +
            " · Retentativas " + str(counts.get("retrying", 0))
        ))
    if grouped_events > 1:
        lines.append("🔔 *Eventos agrupados:* " + md(grouped_events))
    if event.status in ERROR_STATES:
        lines.append("")
        lines.append("*Diagnóstico técnico \\(sem dados privados\\)*")
        frames: list[str] = []
        budget = max(300, 3400 - sum(map(len, lines)))
        for line in diagnostic(job, event):
            encoded = line.replace("\\", "\\\\").replace(chr(96), "\\" + chr(96))
            if sum(map(len, frames)) + len(encoded) + 60 > budget:
                frames.append("Ver traceback completo no Sentry")
                break
            frames.append(encoded)
        fence = chr(96) * 3
        lines.append(fence + "text\n" + "\n".join(frames) + "\n" + fence)
        lines.append("🔎 *Traceback completo:* abra Sentry ou GCP nos botões abaixo\\.")
    else:
        lines.append("🔗 *Correlation:* " + md(correlation))
    return "\n".join(lines), safe_urls(job, sentry if event.status in ERROR_STATES else None, correlation)


async def deliver(
    client: httpx.AsyncClient, config: tuple[str, str, str],
    message: str, links: list[list[dict[str, str]]],
) -> None:
    url, token, chat = config
    response = await client.post(
        url, headers={"Authorization": "Bearer " + token},
        json={"body": message, "chat_id": chat, "parse_mode": "MarkdownV2", "buttons": links},
    )
    if not response.is_success:
        trace_id = response.headers.get("X-Relay-Trace-Id", "")
        LOG.warning("telegram_relay_http_error", extra={
            "http_status": response.status_code,
            "relay_trace_id": valid_correlation(trace_id),
            "stage": "notifications/send",
        })
    response.raise_for_status()
    result = response.json()
    if not isinstance(result, dict) or result.get("ok") is not True:
        LOG.warning("telegram_relay_unacknowledged", extra={
            "http_status": response.status_code, "stage": "notifications/send",
        })
        raise ValueError("Telegram relay delivery was not acknowledged")


async def claim_cursor() -> tuple[str, int] | None:
    owner, now = uuid4().hex, utcnow()
    async with SessionLocal() as session, session.begin():
        row = await session.get(Setting, CURSOR, with_for_update=True)
        if row is None:
            latest = int(await session.scalar(select(func.max(JobEvent.id))) or 0)
            recent = await session.scalar(select(func.min(JobEvent.id)).where(
                JobEvent.created_at >= now - timedelta(minutes=2)
            ))
            # Include the first job that triggered activation, but avoid
            # delivering an unbounded backlog of historic events.
            start = max(0, latest - 40, int(recent) - 1) if recent else latest
            row = Setting(key=CURSOR, value={"cursor": start})
            session.add(row)
            await session.flush()
        prior = dict(row.value or {})
        if prior.get("owner") and prior.get("until", "") > now.isoformat():
            return None
        row.value = {"cursor": int(prior.get("cursor", 0)),
                     "owner": owner, "until": (now + timedelta(seconds=90)).isoformat()}
        return owner, int(prior.get("cursor", 0))


async def release_cursor(owner: str, cursor: int) -> None:
    async with SessionLocal() as session, session.begin():
        row = await session.get(Setting, CURSOR, with_for_update=True)
        if row and (row.value or {}).get("owner") == owner:
            row.value = {"cursor": max(cursor, int(row.value.get("cursor", 0)))}


async def was_sent(key: str, event_id: int) -> bool:
    async with SessionLocal() as session:
        item = await session.get(Setting, "telegram:sent:" + key)
        return bool(item and isinstance(item.value, dict)
                    and int(item.value.get("event_id", 0)) >= event_id)


async def record_sent(key: str, event_id: int) -> None:
    async with SessionLocal() as session, session.begin():
        item = await session.get(Setting, "telegram:sent:" + key, with_for_update=True)
        if item is None:
            session.add(Setting(key="telegram:sent:" + key, value={"event_id": event_id}))
        else:
            item.value = {"event_id": max(event_id, int((item.value or {}).get("event_id", 0)))}


async def drain(*, limit: int = 90) -> dict[str, object]:
    """Independent leased cursor; failed delivery retries without touching jobs."""
    if not 1 <= limit <= 200:
        raise ValueError("Invalid event limit")
    config = credentials()
    if config is None:
        return {"status": "disabled", "events": 0}
    claim = await claim_cursor()
    if claim is None:
        return {"status": "busy", "events": 0}
    owner, cursor = claim
    advanced = cursor
    try:
        async with SessionLocal() as session:
            rows = (await session.execute(
                select(JobEvent, Job).join(Job, Job.id == JobEvent.job_id)
                .where(JobEvent.id > cursor).order_by(JobEvent.id).limit(limit)
            )).all()
            grouped: OrderedDict[str, tuple[JobEvent, Job, int]] = OrderedDict()
            for event, job in rows:
                if event.status not in STATES:
                    advanced = event.id
                    continue
                # Per-job failures/retries, per-batch rollups for routine events.
                scope = (str(job.id) if event.status in ERROR_STATES or not job.batch_id
                         else str(job.batch_id))
                key = scope + ":" + event.status
                if event.status in ERROR_STATES:
                    # Every failed attempt has its own exact Sentry event.
                    key += ":" + str(event.id)
                if key not in grouped and len(grouped) >= 6:
                    break
                previous = grouped.get(key)
                grouped[key] = (event, job, 1 + (previous[2] if previous else 0))
                advanced = event.id
            ids = {job.batch_id for _, job, _ in grouped.values() if job.batch_id}
            batches = {id_: await session.get(JobBatch, id_) for id_ in ids}
            counts = {
                id_: dict((await session.execute(
                    select(Job.status, func.count()).where(Job.batch_id == id_)
                    .group_by(Job.status)
                )).all()) for id_ in ids
            }
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, connect=2.0), follow_redirects=False,
        ) as client:
            for key, (event, job, count) in grouped.items():
                if await was_sent(key, event.id):
                    continue
                message, links = format_message(
                    job, event, batches.get(job.batch_id), counts.get(job.batch_id), count,
                )
                await deliver(client, config, message, links)
                # Commit a per-event marker before advancing the global cursor.
                # Retries after another group fails do not resend prior messages.
                await record_sent(key, event.id)
        return {"status": "completed", "events": len(rows), "messages": len(grouped)}
    except asyncio.CancelledError:
        advanced = cursor
        raise
    except Exception as exc:
        advanced = cursor
        LOG.warning("telegram_job_delivery_failed", extra={"exception_type": type(exc).__name__})
        return {"status": "retry", "events": 0}
    finally:
        await release_cursor(owner, advanced)


async def safe_notify() -> None:
    """Failures of the Telegram provider never change job outcomes."""
    global _last_attempt
    if credentials() is None:
        return
    now = asyncio.get_running_loop().time()
    if _guard.locked() or now - _last_attempt < 2:
        return
    async with _guard:
        _last_attempt = asyncio.get_running_loop().time()
        try:
            async with asyncio.timeout(38):
                for _ in range(4):
                    result = await drain()
                    if result.get("status") != "completed" or not result.get("events"):
                        break
        except Exception as exc:
            LOG.warning("telegram_notification_attempt_failed",
                        extra={"exception_type": type(exc).__name__})
