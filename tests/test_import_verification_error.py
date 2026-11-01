"""Only new operations above 1,000 assets need explicit release approval."""

from unittest.mock import AsyncMock

import pytest

from photointel.errors import AppError, ErrorCode
from photointel.services import verification


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [1, 10, 100, 1000])
async def test_small_and_bounded_imports_do_not_need_gates(monkeypatch, count):
    status = AsyncMock()
    monkeypatch.setattr(verification, "gate_status", status)

    await verification.require_import_gates(object(), count)
    status.assert_not_awaited()


@pytest.mark.asyncio
async def test_large_import_reports_single_scale_approval_and_setup_action(monkeypatch):
    mock = AsyncMock(return_value={
        "items": [{"id": "F", "status": "not_verified"}]
    })
    monkeypatch.setattr(verification, "gate_status", mock)

    with pytest.raises(AppError) as caught:
        await verification.require_import_gates(object(), 1001)

    exc = caught.value
    assert exc.status_code == 409
    assert exc.code == ErrorCode.VERIFICATION_REQUIRED
    assert exc.details["reason"] == "RELEASE_VERIFICATION_PENDING"
    assert exc.details["required_gates"] == ["F"]
    assert exc.details["gates"] == [{
        "id": "F",
        "name": verification.GATES["F"][0],
        "requirement": verification.GATES["F"][2],
        "status": "not_verified",
    }]
    assert exc.details["action"] == {
        "label": "Autorizar importações grandes", "href": "/setup",
    }


@pytest.mark.asyncio
async def test_large_import_with_scale_approval_passes(monkeypatch):
    monkeypatch.setattr(verification, "gate_status", AsyncMock(return_value={
        "items": [{"id": "F", "status": "passed"}],
    }))
    await verification.require_import_gates(object(), 1001)
