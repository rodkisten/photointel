"""Manage-only browser reauthentication to Apple, using short-lived encrypted MFA state."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, SecretStr
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.auth import Identity, require_manage_identity
from photointel.database import get_session
from photointel.services.runtime_settings import effective_settings
from photointel.services.icloud_web_auth import start_login, verify_login, login_readiness

router = APIRouter(
    prefix="/ingestion/web-auth",
    tags=["ingestion"],
    dependencies=[Depends(require_manage_identity)],
)
Session = Annotated[AsyncSession, Depends(get_session)]
Actor = Annotated[Identity, Depends(require_manage_identity)]


class BeginLogin(BaseModel):
    password: SecretStr = Field(min_length=1, max_length=512)


class VerifyLogin(BaseModel):
    challenge: str = Field(min_length=32, max_length=750000)
    code: SecretStr = Field(min_length=6, max_length=6)


@router.get("/status")
async def login_status(session: Session, identity: Actor) -> dict:
    settings = await effective_settings(session)
    return login_readiness(settings)


@router.post("/start")
async def begin_login(body: BeginLogin, session: Session, identity: Actor) -> dict:
    settings = await effective_settings(session)
    return await start_login(settings, identity.email, body.password.get_secret_value())


@router.post("/verify")
async def finish_login(body: VerifyLogin, session: Session, identity: Actor) -> dict:
    settings = await effective_settings(session)
    return await verify_login(
        settings, identity.email, body.challenge, body.code.get_secret_value(),
    )
