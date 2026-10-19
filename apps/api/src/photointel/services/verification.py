"""Release-bound operator evidence gates; installation never unlocks a backfill."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.errors import AppError, ErrorCode
from photointel.models import VerificationGate
from photointel.services.release import get_release_manifest

GATES = {
    "A": ("Fixtures locais", [], "Compose, migrações, API, worker e PWA"),
    "B": ("10 fotos reais do iCloud", ["A"], "Importação, repetição e retomada reais"),
    "C": ("Inferência real no Modal", ["A"], "JoyTag, SigLIP 2 e busca em português"),
    "D": ("100 fotos reais", ["B", "C"], "Fluxo completo, latência e custo medidos"),
    "E": ("1.000 fotos reais", ["D"], "Expansão autorizada, capacidade e recuperação"),
    "F": (
        "Backfill de produção",
        ["E"],
        "Safari físico, autenticação, restauração, capacidade e gastos aprovados",
    ),
}


async def gate_status(session: AsyncSession) -> dict[str, Any]:
    release = get_release_manifest()
    sha = release["git_sha"] if release["provenance_status"] == "identified" else None
    rows = {
        row.id: row for row in (await session.scalars(select(VerificationGate))).all()
    }
    passed: set[str] = set()
    items = []
    for key, (name, previous, requirement) in GATES.items():
        row = rows.get(key)
        current = bool(row and sha and row.release_sha == sha)
        prerequisites = all(value in passed for value in previous)
        status = row.status if current and row else "not_verified"
        reason = requirement
        if row and not current:
            reason = "Evidência pertence a outro release ou release não identificado"
        if not prerequisites:
            status = "blocked"
            reason = "Conclua primeiro: " + ", ".join(previous)
        if status == "passed":
            passed.add(key)
        items.append(
            {
                "id": key,
                "name": name,
                "status": status,
                "reason": reason,
                "requirements": [requirement],
                "evidence": row.evidence if current and row else [],
                "verified_at": row.verified_at if current and row else None,
            }
        )
    return {"items": items, "full_backfill_unlocked": "F" in passed}


async def require_import_gates(session: AsyncSession, requested: int) -> None:
    required = ["A"] if requested <= 10 else ["B", "C"] if requested <= 100 else ["D"]
    if requested > 1000:
        required = ["E", "F"]
    states = {
        item["id"]: item["status"] for item in (await gate_status(session))["items"]
    }
    pending = [key for key in required if states[key] != "passed"]
    if pending:
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            "Validação necessária antes deste lote: " + ", ".join(pending),
            409,
            {"required_gates": pending},
        )
