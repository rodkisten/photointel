"""Authenticated Firebase Installation ID registration for PhotoIntel PWA."""
from __future__ import annotations

from datetime import timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from photointel.auth import Identity, require_identity
from photointel.database import SessionLocal
from photointel.models import Setting, utcnow
from photointel.services import fcm_notify

router = APIRouter(dependencies=[Depends(require_identity)])


class Registration(BaseModel):
    installation_id: str = Field(min_length=16, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")


@router.get("/push/status", tags=["push"])
async def status(identity: Identity = Depends(require_identity)) -> dict:
    async with SessionLocal() as session:
        devices = (await session.scalars(select(Setting).where(
            Setting.key.like(fcm_notify.PREFIX + "%"),
            Setting.updated_at >= utcnow() - timedelta(days=45),
        ).limit(64))).all()
    count = sum(
        1 for item in devices
        if isinstance(item.value, dict) and item.value.get("email") == identity.email
    )
    return {"enabled": fcm_notify.configured(), "registered_devices": count}


@router.post("/push/registrations", status_code=201, tags=["push"])
async def register_installation(
    body: Registration, identity: Identity = Depends(require_identity),
) -> dict[str, bool]:
    key = fcm_notify.device_key(body.installation_id)
    async with SessionLocal() as session, session.begin():
        current = await session.get(Setting, key)
        if current is None:
            devices = (await session.scalars(select(Setting).where(
                Setting.key.like(fcm_notify.PREFIX + "%"),
                Setting.updated_at >= utcnow() - timedelta(days=45),
            ).limit(64))).all()
            total = sum(
                1 for item in devices
                if isinstance(item.value, dict) and item.value.get("email") == identity.email
            )
            if total >= 8:
                raise HTTPException(status_code=409, detail="Limite de dispositivos ativos atingido")
        value = {"installation_id": body.installation_id, "email": identity.email}
        await session.execute(insert(Setting).values(
            key=key, value=value, updated_at=utcnow(),
        ).on_conflict_do_update(
            index_elements=[Setting.key],
            set_={"value": value, "updated_at": utcnow()},
        ))
    # Registration is useful even before the FCM sender is enabled.
    return {"registered": True}


@router.delete("/push/registrations", status_code=204, tags=["push"])
async def unregister_installation(
    body: Registration, identity: Identity = Depends(require_identity),
) -> None:
    key = fcm_notify.device_key(body.installation_id)
    async with SessionLocal() as session, session.begin():
        row = await session.get(Setting, key, with_for_update=True)
        if row and isinstance(row.value, dict) and row.value.get("email") == identity.email:
            await session.delete(row)


@router.post("/push/test", tags=["push"])
async def test_installation(identity: Identity = Depends(require_identity)) -> dict:
    """Explicit user test, never invoked by automatic job processing."""
    if not fcm_notify.configured():
        raise HTTPException(status_code=503, detail="FCM_JOB_EVENTS_ENABLED e FCM_PROJECT_ID não configurados")
    async with SessionLocal() as session:
        devices = (await session.scalars(select(Setting).where(
            Setting.key.like(fcm_notify.PREFIX + "%"),
            Setting.updated_at >= utcnow() - timedelta(days=45),
        ).limit(64))).all()
    fids = [
        row.value["installation_id"]
        for row in devices
        if isinstance(row.value, dict)
        and row.value.get("email") == identity.email
        and isinstance(row.value.get("installation_id"), str)
        and fcm_notify.FID_RE.fullmatch(row.value["installation_id"])
    ]
    if not fids:
        raise HTTPException(status_code=409, detail="Nenhum dispositivo registrado")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(7, connect=2), follow_redirects=False) as client:
            for fid in fids:
                await fcm_notify.send_message(
                    client, fid, title="PhotoIntel · Notificações ativas",
                    body="Seu dispositivo está recebendo mensagens do Firebase.",
                    status="completed", scope="test:notifications", job_id="",
                    event_id=0, done=1, total=1,
                )
    except Exception as exc:
        # Never echo credentials, provider response or installation identifiers.
        raise HTTPException(status_code=502, detail="Falha no envio FCM; consulte os logs da API") from exc
    return {"sent": len(fids)}
