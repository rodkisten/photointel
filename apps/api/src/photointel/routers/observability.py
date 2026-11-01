"""Authenticated Sentry Event ID -> exact event permalink resolver.

Never expose the Sentry API token to browsers or follow remote redirects.
"""
import os
import re

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import select
from fastapi.responses import RedirectResponse

from photointel.auth import require_identity
from photointel.database import SessionLocal
from photointel.models import Job
from photointel.errors import AppError, ErrorCode
from photointel.sentry_observability import event_id, sentry_organization

router = APIRouter(dependencies=[Depends(require_identity)])
ISSUE_ID = re.compile(r"^[0-9]{1,24}$")


@router.get("/observability/sentry-events/{identifier}", tags=["observability"])
async def sentry_event_redirect(identifier: str) -> RedirectResponse:
    """Always resolve the event using Sentry's official API, never guess an issue."""
    normalized = event_id(identifier)
    if normalized is None:
        raise AppError(ErrorCode.INVALID_REQUEST, "ID de evento inválido", 422)
    org = sentry_organization()
    token = os.getenv("SENTRY_API_TOKEN", "").strip()
    if not org or not token:
        raise AppError(
            ErrorCode.INTERNAL_ERROR,
            "Integração Sentry não configurada: informe SENTRY_ORG e SENTRY_API_TOKEN",
            503,
        )
    endpoint = f"https://sentry.io/api/0/organizations/{org}/eventids/{normalized}/"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(8.0, connect=3.0),
            follow_redirects=False,
        ) as client:
            response = await client.get(
                endpoint, headers={"Authorization": f"Bearer {token}"},
            )
    except (httpx.RequestError, httpx.TimeoutException):
        raise AppError(
            ErrorCode.INTERNAL_ERROR,
            "Sentry indisponível para resolver o evento",
            503,
        ) from None
    if response.status_code == 404:
        raise AppError(
            ErrorCode.NOT_FOUND,
            "Evento ainda não encontrado no Sentry; verifique o DSN do serviço",
            404,
        )
    if response.status_code != 200:
        raise AppError(
            ErrorCode.INTERNAL_ERROR,
            "Sentry não autorizou a consulta do evento",
            502,
        )
    if len(response.content) > 1024 * 1024:
        raise AppError(ErrorCode.INTERNAL_ERROR, "Resposta do Sentry inválida", 502)
    try:
        result = response.json()
        group_id = str(result["groupId"])
        project = result["projectSlug"]
    except (KeyError, ValueError, TypeError):
        raise AppError(ErrorCode.INTERNAL_ERROR, "Evento Sentry inválido", 502) from None
    if not ISSUE_ID.fullmatch(group_id) or not isinstance(project, str):
        raise AppError(ErrorCode.INTERNAL_ERROR, "Evento Sentry inválido", 502)
    # The event ID, not 'latest', selects the exact failing attempt.
    target = (
        f"https://sentry.io/organizations/{org}/issues/{group_id}/"
        f"events/{normalized}/"
    )
    return RedirectResponse(
        target, status_code=302, headers={"Cache-Control": "no-store"}
    )


@router.get("/observability/assets/{asset_id}/latest-error", tags=["observability"])
async def latest_asset_error(asset_id: str) -> dict[str, str | bool | None]:
    """Find an actual worker failure before offering a Sentry link in the gallery."""
    try:
        from uuid import UUID

        identifier = UUID(asset_id)
    except ValueError:
        raise AppError(ErrorCode.INVALID_REQUEST, "ID da foto inválido", 422) from None
    async with SessionLocal() as session:
        candidates = (
            await session.scalars(
                select(Job).where(Job.asset_id == identifier)
                .order_by(Job.created_at.desc(), Job.id.desc())
                .limit(20)
            )
        ).all()
    for job in candidates:
        details = job.error_details if isinstance(job.error_details, dict) else {}
        history = job.progress.get("sentry_attempt_events", [])
        historical_id = None
        if isinstance(history, list) and history:
            last = history[-1]
            historical_id = last.get("event_id") if isinstance(last, dict) else None
        sentry_id = event_id(details.get("sentry_event_id") or historical_id)
        if sentry_id:
            payload = job.payload if isinstance(job.payload, dict) else {}
            correlation = payload.get("correlation_id")
            return {
                "found": True, "sentry_event_id": sentry_id,
                "job_id": str(job.id),
                "correlation_id": correlation if isinstance(correlation, str) else None,
                "error_code": job.error_code,
            }
    return {"found": False, "sentry_event_id": None, "job_id": None,
            "correlation_id": None, "error_code": None}
