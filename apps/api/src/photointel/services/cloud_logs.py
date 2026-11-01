"""Read-only, tightly scoped Cloud Logging diagnostics for the mobile incident viewer.

Only allowlisted structured fields are returned. Never expose raw log payloads,
exception messages, request URLs, headers, tokens, photos or arbitrary queries.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import google.auth
import httpx
from google.auth.transport.requests import Request as GoogleAuthRequest

logger = logging.getLogger("photointel.observability")
_PROJECT = "photointel"
_API = "https://logging.googleapis.com/v2/entries:list"
_SAFE_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_SAFE_EVENT = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_SAFE_TYPE = re.compile(r"^[A-Za-z][A-Za-z0-9_.]{0,100}$")
_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"})
_SERVICES = frozenset({"photointel-api", "photointel-worker", "photointel-discover"})


def canonical_id(value: str) -> str | None:
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError):
        return None
    return str(parsed) if str(parsed) == value and parsed.version == 4 else None


def _safe_text(value: Any, pattern: re.Pattern[str]) -> str | None:
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def _safe_int(value: Any, minimum: int, maximum: int) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum else None


def _payload(entry: dict[str, Any]) -> dict[str, Any]:
    payload = entry.get("jsonPayload")
    if isinstance(payload, dict):
        return payload
    raw = entry.get("textPayload")
    if not isinstance(raw, str) or len(raw) > 16384:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def normalize_entry(entry: dict[str, Any], correlation_id: str) -> dict[str, Any] | None:
    """Whitelist structured fields, validate the UUID again, and omit raw messages."""
    payload = _payload(entry)
    if payload.get("correlation_id") != correlation_id:
        return None
    resource = entry.get("resource")
    resource = resource if isinstance(resource, dict) else {}
    labels = resource.get("labels")
    labels = labels if isinstance(labels, dict) else {}
    service = labels.get("service_name") or labels.get("job_name")
    if service not in _SERVICES:
        return None
    timestamp = entry.get("timestamp")
    if not isinstance(timestamp, str) or len(timestamp) > 40:
        timestamp = None
    severity = entry.get("severity")
    severity = severity if severity in {"DEFAULT", "DEBUG", "INFO", "NOTICE",
                                        "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"} else "DEFAULT"
    reason = payload.get("reason")
    if not _safe_text(reason, _SAFE_CODE):
        reason = None
    return {
        "timestamp": timestamp,
        "severity": severity,
        "service": service,
        "event": _safe_text(payload.get("event"), _SAFE_EVENT),
        "status_code": _safe_int(payload.get("status_code"), 100, 599),
        "error_code": _safe_text(payload.get("error_code"), _SAFE_CODE),
        "reason": reason,
        "method": payload.get("method") if payload.get("method") in _METHODS else None,
        "route_group": payload.get("route_group") if payload.get("route_group") in {"/v1/*", "other"} else None,
        "exception_type": _safe_text(payload.get("exception_type"), _SAFE_TYPE),
        "job_type": _safe_text(payload.get("job_type"), _SAFE_EVENT),
        "job_id": canonical_id(payload.get("job_id")) if isinstance(payload.get("job_id"), str) else None,
    }


def _get_token() -> str:
    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/logging.read"]
    )
    if not credentials.valid or not credentials.token:
        credentials.refresh(GoogleAuthRequest())
    if not credentials.token:
        raise RuntimeError("Missing workload credentials")
    return str(credentials.token)


async def read_incident(correlation_id: str) -> list[dict[str, Any]]:
    """One fixed project, bounded time window and bounded result set. No free-form filter."""
    if canonical_id(correlation_id) is None:
        raise ValueError("Invalid correlation ID")
    token = await asyncio.to_thread(_get_token)
    since = (datetime.now(UTC) - timedelta(days=14)).isoformat().replace("+00:00", "Z")
    selector = (
        '(resource.type="cloud_run_revision" AND '
        'resource.labels.service_name="photointel-api") OR '
        '(resource.type="cloud_run_job" AND '
        '(resource.labels.job_name="photointel-worker" OR '
        'resource.labels.job_name="photointel-discover"))'
    )
    query = f'({selector}) AND timestamp>="{since}" AND SEARCH("{correlation_id}")'
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(8.0, connect=3.0), follow_redirects=False
    ) as client:
        response = await client.post(
            _API,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"resourceNames": [f"projects/{_PROJECT}"], "filter": query,
                  "orderBy": "timestamp desc", "pageSize": 30},
        )
    response.raise_for_status()
    if len(response.content) > 512 * 1024:
        raise ValueError("Oversized Cloud Logging response")
    payload = response.json()
    items = payload.get("entries", []) if isinstance(payload, dict) else []
    if not isinstance(items, list):
        return []
    result: list[dict[str, Any]] = []
    for entry in items[:30]:
        if isinstance(entry, dict):
            safe = normalize_entry(entry, correlation_id)
            if safe:
                result.append(safe)
    return result[:20]
