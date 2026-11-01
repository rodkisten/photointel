"""Privacy-safe request/job correlation propagated through PostgreSQL work items.

Correlation IDs are opaque UUIDs, not Cloud Trace spans. They are searchable in
Cloud Logging as jsonPayload.correlation_id and never contain user/photo metadata.
"""
from contextvars import ContextVar
from typing import Any
from uuid import UUID, uuid4

correlation_context: ContextVar[str | None] = ContextVar(
    "photointel_correlation_id", default=None
)


def valid_correlation(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = str(UUID(value))
        return parsed if parsed == value else None
    except ValueError:
        return None


def current_correlation() -> str:
    return valid_correlation(correlation_context.get()) or str(uuid4())


def job_correlation(payload: dict[str, Any] | None) -> str:
    return valid_correlation((payload or {}).get("correlation_id")) or current_correlation()
