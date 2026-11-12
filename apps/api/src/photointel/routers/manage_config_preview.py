"""Authenticated Manage-only preview backed by the production Python converter."""
from __future__ import annotations

import json
import os
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from photointel.auth import Identity, require_manage_identity

router = APIRouter(prefix="/manage", tags=["manage"], dependencies=[Depends(require_manage_identity)])


class PreviewInput(BaseModel):
    value: str = Field(min_length=1, max_length=120_000)


@router.post("/config/preview")
async def preview(body: PreviewInput) -> dict[str, Any]:
    # The API image includes the repository's infra package. Do not execute a
    # shell or create files; use the same conversion functions as deployment.
    from infra.gcp.gcp_env import preview_config

    try:
        result = preview_config(body.value)
    except SystemExit:
        # Production parser errors can contain names; never echo raw input.
        return {"ok": False, "error": "Configuração inválida; confira referências, campos obrigatórios e duplicatas."}
    return result
