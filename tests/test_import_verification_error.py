"""Small iCloud batches must report actionable release verification blockers."""
from unittest.mock import AsyncMock

import pytest

from photointel.errors import AppError, ErrorCode
from photointel.services import verification


@pytest.mark.asyncio
async def test_ten_photo_import_reports_gate_a_and_setup_action(monkeypatch):
    mock = AsyncMock(return_value={"items": [
        {"id": key, "status": "not_verified"} for key in verification.GATES
    ]})
    monkeypatch.setattr(verification, "gate_status", mock)

    with pytest.raises(AppError) as caught:
        await verification.require_import_gates(object(), 10)

    exc = caught.value
    assert exc.status_code == 409
    assert exc.code == ErrorCode.VERIFICATION_REQUIRED
    assert exc.details["reason"] == "RELEASE_VERIFICATION_PENDING"
    assert exc.details["required_gates"] == ["A"]
    assert exc.details["gates"] == [{
        "id": "A", "name": "Fixtures locais",
        "requirement": "Compose, migrações, API, worker e PWA",
        "status": "not_verified",
    }]
    assert exc.details["action"] == {
        "label": "Abrir Preparação e validação", "href": "/setup",
    }
    assert "Gate" not in exc.message or "Fixtures locais" in exc.message


@pytest.mark.asyncio
async def test_validated_ten_photo_import_does_not_raise(monkeypatch):
    monkeypatch.setattr(verification, "gate_status", AsyncMock(return_value={
        "items": [
            {"id": key, "status": "passed" if key == "A" else "blocked"}
            for key in verification.GATES
        ],
    }))
    await verification.require_import_gates(object(), 10)


@pytest.mark.asyncio
async def test_large_import_still_requires_later_gates(monkeypatch):
    monkeypatch.setattr(verification, "gate_status", AsyncMock(return_value={
        "items": [
            {"id": key, "status": "passed" if key == "A" else "not_verified"}
            for key in verification.GATES
        ],
    }))
    with pytest.raises(AppError) as caught:
        await verification.require_import_gates(object(), 100)
    assert caught.value.details["required_gates"] == ["B", "C"]
