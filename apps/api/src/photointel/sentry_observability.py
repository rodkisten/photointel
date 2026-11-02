"""Sentry runtime: privacy-first capture, cross-request traces and exact event IDs.

Sentry is opt-in. Without a configured DSN every method is a harmless no-op.
Photograph filenames, source URLs, credentials, SQL and image bytes never leave.
"""
from __future__ import annotations

import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, cast

import sentry_sdk

_HEX_EVENT = re.compile(r"^[0-9a-f]{32}$")
_TRACE = re.compile(r"^[0-9a-f]{32}-[0-9a-f]{16}(?:-[01])?$")
_ORG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
_BAGGAGE = re.compile(r"^[\x20-\x7e]{1,2048}$")


# Keep actionable exception messages without uploading private media names,
# signed provider URLs, filesystem locations or credentials.
_PRIVATE_URL = re.compile(r"(?i)\b(?:https?|ftp|s3|gs)://[^\s\x22'<>]+")
_PRIVATE_KV = re.compile(
    r"(?i)\b(authorization|password|passwd|secret|api[_-]?key|"
    r"access[_-]?token|refresh[_-]?token|token|cookie)\s*[:=]\s*[^\s,;]+"
)
_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]+")
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
_LOCAL_PATH = re.compile(r"(?<!\w)/(?:[A-Za-z0-9_.-]+/){1,}[A-Za-z0-9_.-]+")
_MEDIA_FILENAME = re.compile(r"(?i)\b[^\s/\\]+[.](?:heic|heif|jpe?g|png|webp|avif|mov|mp4)\b")


def _safe_exception_text(value: Any) -> str:
    if value is None:
        return ""
    message = str(value).replace("\x00", "")
    message = _PRIVATE_URL.sub("[URL redigida]", message)
    message = _PRIVATE_KV.sub(r"\1=[redigido]", message)
    message = _BEARER.sub("Bearer [redigido]", message)
    message = _JWT.sub("[token redigido]", message)
    message = _EMAIL.sub("[email redigido]", message)
    message = _LOCAL_PATH.sub("[caminho redigido]", message)
    message = _MEDIA_FILENAME.sub("[arquivo redigido]", message)
    return message[:2048]


def event_id(value: Any) -> str | None:
    if not isinstance(value, str) or not _HEX_EVENT.fullmatch(value.lower()):
        return None
    return value.lower()


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
        # Preserve the actual failure reason and chained exceptions safely.
        item["value"] = _safe_exception_text(item.get("value")) or str(
            item.get("type") or "RuntimeError"
        )
        for frame in item.get("stacktrace", {}).get("frames", []):
            if isinstance(frame.get("filename"), str):
                frame["filename"] = frame["filename"].split("?", 1)[0].split("#", 1)[0]
            frame.pop("vars", None)
            frame.pop("pre_context", None)
            frame.pop("post_context", None)
            frame.pop("context_line", None)
            frame.pop("abs_path", None)
    # SDK log entries also need sanitization, not blind exception suppression.
    if "message" in event:
        event["message"] = _safe_exception_text(event["message"])
    if isinstance(event.get("logentry"), dict):
        event["logentry"] = {
            key: _safe_exception_text(value)
            for key, value in event["logentry"].items()
            if key in {"message", "formatted"}
        }
    # Keep only anonymous distributed-trace fields, never SDK device contexts.
    contexts = event.get("contexts")
    trace = contexts.get("trace") if isinstance(contexts, dict) else None
    event["contexts"] = (
        {"trace": {
            key: value for key, value in trace.items()
            if key in {"trace_id", "span_id", "parent_span_id", "op"}
        }} if isinstance(trace, dict) else {}
    )
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
        default_integrations=False,
        auto_enabling_integrations=False,
        include_local_variables=False,
        max_breadcrumbs=0,
        attach_stacktrace=True,
        # Sentry Event is a TypedDict; the sanitizer accepts and returns the same map.
        before_send=cast(Any, _scrub),
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

@contextmanager
def request_trace_scope(headers: Any) -> Iterator[None]:
    """Continue only validated Sentry context, with a separate request scope."""
    if not sentry_sdk.is_initialized():
        yield
        return
    accepted: dict[str, str] = {}
    parent = headers.get("sentry-trace")
    baggage = headers.get("baggage")
    if isinstance(parent, str) and _TRACE.fullmatch(parent):
        accepted["sentry-trace"] = parent
    if isinstance(baggage, str) and _BAGGAGE.fullmatch(baggage) and all(
        entry.strip().startswith("sentry-") for entry in baggage.split(",")
    ):
        accepted["baggage"] = baggage
    with sentry_sdk.isolation_scope():
        if accepted:
            sentry_sdk.continue_trace(accepted)
        with sentry_sdk.start_transaction(
            op="http.server", name="photointel.api.request"
        ):
            yield
