"""Sentry runtime: privacy-first capture, cross-request traces and exact event IDs.

Sentry is opt-in. Without a configured DSN every method is a harmless no-op.
Photograph filenames, source URLs, credentials, SQL and image bytes never leave.
"""
from __future__ import annotations

import os
import re
from contextlib import contextmanager
from typing import Any, Iterator
from uuid import UUID

import sentry_sdk

_HEX_EVENT = re.compile(r"^[0-9a-f]{32}$")
_TRACE = re.compile(r"^[0-9a-f]{32}-[0-9a-f]{16}(?:-[01])?$")
_ORG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
_BAGGAGE = re.compile(r"^[\x20-\x7e]{1,2048}$")


def event_id(value: Any) -> str | None:
    return value.lower() if isinstance(value, str) and _HEX_EVENT.fullmatch(value.lower()) else None


def _scrub(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    # Do not upload headers, cookies, IPs, URLs, user profiles or breadcrumbs.
    for key in ("request", "user", "breadcrumbs", "extra", "modules", "server_name"):
        event.pop(key, None)
    event["tags"] = {
        key: value for key, value in event.get("tags", {}).items()
        if key in {"correlation_id", "job_id", "job_type", "error_code", "service"}
        and isinstance(value, str)
        and len(value) <= 128
    }
    for item in event.get("exception", {}).get("values", []):
        # Retain exception class and frame positions, never raw provider messages.
        item["value"] = str(item.get("type", "RuntimeError"))
        for frame in item.get("stacktrace", {}).get("frames", []):
            frame.pop("vars", None)
            frame.pop("pre_context", None)
            frame.pop("post_context", None)
            frame.pop("context_line", None)
            frame.pop("abs_path", None)
    event.pop("message", None)
    return event


def configure_sentry(service: str) -> bool:
    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    sentry_sdk.init(
        dsn=dsn,
        environment=os.getenv("APP_ENV", "production"),
        release=os.getenv("RELEASE_GIT_SHA") or None,
        traces_sample_rate=0.10,
        profiles_sample_rate=0.0,
        send_default_pii=False,
        include_local_variables=False,
        max_breadcrumbs=0,
        attach_stacktrace=True,
        before_send=_scrub,
        trace_propagation_targets=[],
    )
    sentry_sdk.set_tag("service", service)
    return True


def capture_exception(
    exc: BaseException, *, correlation_id: str | None = None,
    job_id: str | None = None, job_type: str | None = None,
    error_code: str | None = None,
) -> str | None:
    if not sentry_sdk.is_initialized():
        return None
    with sentry_sdk.new_scope() as scope:
        for key, value in {
            "correlation_id": correlation_id,
            "job_id": job_id,
            "job_type": job_type,
            "error_code": error_code,
        }.items():
            if value:
                scope.set_tag(key, value[:128])
        return event_id(sentry_sdk.capture_exception(exc))


def trace_headers() -> dict[str, str]:
    if not sentry_sdk.is_initialized():
        return {}
    result: dict[str, str] = {}
    parent = sentry_sdk.get_traceparent()
    if parent and _TRACE.fullmatch(parent):
        result["sentry_trace"] = parent
    baggage = sentry_sdk.get_baggage()
    # Sentry propagation only; reject arbitrary/oversized baggage values.
    if baggage and _BAGGAGE.fullmatch(baggage) and all(
        part.strip().startswith("sentry-") for part in baggage.split(",")
    ):
        result["sentry_baggage"] = baggage
    return result


@contextmanager
def continue_job_trace(payload: dict[str, Any]) -> Iterator[None]:
    if not sentry_sdk.is_initialized():
        yield
        return
    headers: dict[str, str] = {}
    parent = payload.get("sentry_trace")
    baggage = payload.get("sentry_baggage")
    if isinstance(parent, str) and _TRACE.fullmatch(parent):
        headers["sentry-trace"] = parent
    if isinstance(baggage, str) and _BAGGAGE.fullmatch(baggage):
        headers["baggage"] = baggage
    with sentry_sdk.isolation_scope():
        if headers:
            sentry_sdk.continue_trace(headers)
        with sentry_sdk.start_span(op="queue.process", name="photointel.worker.job"):
            yield


def sentry_organization() -> str | None:
    name = os.getenv("SENTRY_ORG", "").strip()
    return name if _ORG.fullmatch(name) else None
