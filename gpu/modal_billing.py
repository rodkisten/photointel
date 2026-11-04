"""Read-only, token-protected Modal billing bridge for PhotoIntel Manage.

Deploy with: uv run --group gpu modal deploy gpu/modal_billing.py
Requires Modal Team or Enterprise billing API and a Modal secret named
photo-intelligence-billing containing MANAGE_COSTS_TOKEN (32+ random characters).
The HTTPS *.modal.run URL is then stored in Manage's MODAL_BILLING_URL; the
same token is stored as a Manage Worker secret MODAL_BILLING_TOKEN.
No Modal token or invoice contents are sent to the browser beyond totals.
"""
from __future__ import annotations

import hmac
import os
import re
from datetime import datetime, timezone

import modal

app = modal.App("photo-intelligence-billing")
image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi>=0.115,<1")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("photo-intelligence-billing")],
    timeout=60,
    min_containers=0,
    max_containers=1,
)
@modal.asgi_app()
def billing():
    from fastapi import FastAPI, HTTPException, Request

    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @api.get("/report")
    def report(month: str, request: Request):
        expected = os.environ.get("MANAGE_COSTS_TOKEN", "")
        received = request.headers.get("authorization", "")
        if len(expected) < 32 or not hmac.compare_digest(received, "Bearer " + expected):
            raise HTTPException(status_code=401, detail="unauthorized")
        if not re.fullmatch(r"20\d{2}-(0[1-9]|1[0-2])", month):
            raise HTTPException(status_code=422, detail="invalid month")
        year, number = (int(x) for x in month.split("-"))
        start = datetime(year, number, 1, tzinfo=timezone.utc)
        if start > datetime.now(timezone.utc):
            raise HTTPException(status_code=422, detail="future month")
        if number == 12:
            end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
        else:
            end = datetime(year, number + 1, 1, tzinfo=timezone.utc)
        # Billing API may return a plan/permission error. Never fabricate totals.
        try:
            workspace = modal.Workspace.from_context()
            summary = workspace.billing.summary(cycle=month)
            rows = workspace.billing.report(start=start, end=end, resolution="d")
        except Exception as exc:
            raise HTTPException(status_code=503, detail="billing API unavailable for workspace or plan") from exc
        grouped = {}
        for entry in rows:
            name = str(getattr(entry, "description", None) or getattr(entry, "object_id", "Modal"))
            grouped[name] = grouped.get(name, 0.0) + float(entry.cost)
        return {
            "currency": "USD",
            "month": month,
            "billed_total": float(summary.billed_cost),
            "metered_total": float(summary.metered_cost),
            "items": [
                {"name": name, "cost": round(cost, 6), "detail": "Metered before credits"}
                for name, cost in sorted(grouped.items(), key=lambda x: x[1], reverse=True)
            ],
        }

    return api
