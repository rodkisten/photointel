"""Authenticated Sentry Event ID -> exact event permalink resolver.

Never expose the Sentry API token to browsers or follow remote redirects.
"""
import os
import re

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse

from photointel.auth import require_identity
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
    return RedirectResponse(target, status_code=302, headers={"Cache-Control": "no-store"})
