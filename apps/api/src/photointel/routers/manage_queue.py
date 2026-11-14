"""Manage-only entrypoints for the existing durable Photos queue controller.

The caller must present a signed Manage Access JWT; this route does not
accept the ordinary Photos user session or any shared plaintext secret.
"""
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.auth import Identity, require_manage_identity
from photointel.database import get_session
from photointel.routers.job_control import control_queue, read_control

router = APIRouter(prefix="/manage/jobs", tags=["manage-jobs"],
                   dependencies=[Depends(require_manage_identity)])
Session = Annotated[AsyncSession, Depends(get_session)]
Actor = Annotated[Identity, Depends(require_manage_identity)]


@router.get("/control")
async def manage_read_control(session: Session):
    return await read_control(session)


@router.post("/control/{action}")
async def manage_control_queue(
    action: Literal["pause", "resume"],
    session: Session,
    actor: Actor,
    background_tasks: BackgroundTasks,
):
    # Reuse the exact transactional state machine and audit trail of Photos.
    return await control_queue(action, session, actor, background_tasks)
