"""Minimal, release-bound approval for genuinely large import operations."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.errors import AppError, ErrorCode
from photointel.models import VerificationGate
from photointel.services.release import get_release_manifest

# Historical A-E records remain in the database for audit purposes.
# Ordinary, bounded imports and automatic synchronization do not require gates.
LARGE_IMPORT_THRESHOLD = 1000
GATES = {
    "F": (
        "Importações acima de 1.000 fotos",
        [],
        "Teste uma importação pequena e confira limites de capacidade e custos antes de autorizar a escala.",
    ),
}


async def gate_status(session: AsyncSession) -> dict[str, Any]:
    release = get_release_manifest()
    sha = release.get("git_sha") if release.get("provenance_status") == "identified" else None
    rows = {
        row.id: row for row in (await session.scalars(select(VerificationGate))).all()
    }
    items = []
    for key, (name, _, requirement) in GATES.items():
        row = rows.get(key)
        current = bool(row and sha and row.release_sha == sha)
        status = row.status if current and row else "not_verified"
        reason = (
            "A autorização foi registrada para outra versão da API; confirme antes de iniciar uma nova operação grande."
            if row and not current
            else requirement
        )
        items.append({
            "id": key,
            "name": name,
            "status": status,
            "reason": reason,
            "requirements": [requirement],
            "evidence": row.evidence if current and row else [],
            "verified_at": row.verified_at if current and row else None,
        })
    return {
        "items": items,
        "full_backfill_unlocked": items[0]["status"] == "passed",
    }


async def require_import_gates(session: AsyncSession, requested: int) -> None:
    """Only newly authorized operations above the threshold need approval."""
    if requested <= LARGE_IMPORT_THRESHOLD:
        return
    states = {
        item["id"]: item["status"]
        for item in (await gate_status(session))["items"]
    }
    if states.get("F") == "passed":
        return
    raise AppError(
        ErrorCode.VERIFICATION_REQUIRED,
        "Para importar mais de 1.000 fotos, valide a autorização de escala em Preparação e validação. "
        "Lotes de até 1.000 fotos não exigem gates.",
        409,
        {
            "reason": "RELEASE_VERIFICATION_PENDING",
            "required_gates": ["F"],
            "gates": [{
                "id": "F",
                "name": GATES["F"][0],
                "requirement": GATES["F"][2],
                "status": states.get("F", "not_verified"),
            }],
            "action": {
                "label": "Autorizar importações grandes",
                "href": "/setup",
            },
        },
    )
