"""Local structured logs; private payloads and exception values are never emitted."""

import logging
import re
from collections.abc import MutableMapping
from datetime import datetime
from typing import Any, cast
from uuid import UUID

import structlog

SENSITIVE_KEYS = {
    "password",
    "secret",
    "token",
    "authorization",
    "cookie",
    "credential",
    "image",
    "image_bytes",
    "image_payload",
    "photo",
    "embedding",
    "keywords",
    "tags",
    "raw_predictions",
    "query",
    "search_query",
    "latitude",
    "longitude",
    "database_url",
    "dsn",
    "private_key",
    "access_key",
}
SENSITIVE_PATTERNS = re.compile(
    r"(?i)(bearer\s+)[^\s]+|((?:password|token|secret|cookie)[=:]\s*)[^\s,;]+"
)
SIGNED_URL = re.compile(r"https?://[^\s\"'<>]+\?[^\s\"'<>]+")
CREDENTIAL_URL = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s/@]+:[^\s/@]+@[^\s]+")
JWT_VALUE = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")


def redact_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[redacted]"
            if any(part in str(key).lower() for part in SENSITIVE_KEYS)
            else redact_value(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact_value(item) for item in value]
    if isinstance(value, bytes):
        return "[binary redacted]"
    if isinstance(value, str):
        value = SENSITIVE_PATTERNS.sub(
            lambda match: (match.group(1) or match.group(2) or "") + "[redacted]",
            value,
        )
        value = SIGNED_URL.sub("[private URL redacted]", value)
        value = CREDENTIAL_URL.sub("[credential URL redacted]", value)
        return JWT_VALUE.sub("[JWT redacted]", value)
    if isinstance(value, (datetime, UUID)):
        return str(value)
    if value is None or isinstance(value, (int, float, bool)):
        return value
    # SDK objects and exceptions may contain credentials in their repr.
    return f"[{type(value).__name__} omitted]"


def redact_log(
    _: Any,
    __: str,
    event_dict: MutableMapping[str, Any],
) -> dict[str, Any]:
    exception = event_dict.pop("exc_info", None)
    event_dict.pop("stack_info", None)
    if exception:
        event_dict["exception_type"] = (
            exception[0].__name__
            if isinstance(exception, tuple) and exception[0]
            else "Exception"
        )
    return cast(dict[str, Any], redact_value(dict(event_dict)))


def configure_logging(level: str = "INFO") -> None:
    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
    ]
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=[*shared, structlog.stdlib.ExtraAdder()],
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            redact_log,
            structlog.processors.JSONRenderer(),
        ],
    )
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    logging.basicConfig(handlers=[handler], level=level.upper(), force=True)
    # SDK debug logs may contain signed object URLs and request authentication.
    for name in ("botocore", "boto3", "httpx", "httpcore", "urllib3"):
        logging.getLogger(name).setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").disabled = True
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
