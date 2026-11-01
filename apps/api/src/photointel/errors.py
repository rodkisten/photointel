"""Stable public error taxonomy; internal exception text never reaches clients."""

from enum import StrEnum
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


class ErrorCode(StrEnum):
    ICLOUD_AUTH_EXPIRED = "ICLOUD_AUTH_EXPIRED"
    ICLOUD_ACCESS_DENIED = "ICLOUD_ACCESS_DENIED"
    ICLOUD_RATE_LIMITED = "ICLOUD_RATE_LIMITED"
    ICLOUD_ASSET_UNAVAILABLE = "ICLOUD_ASSET_UNAVAILABLE"
    MEDIA_DOWNLOAD_FAILED = "MEDIA_DOWNLOAD_FAILED"
    MEDIA_DECODE_FAILED = "MEDIA_DECODE_FAILED"
    R2_UPLOAD_FAILED = "R2_UPLOAD_FAILED"
    GPU_UNAVAILABLE = "GPU_UNAVAILABLE"
    MODEL_LOAD_FAILED = "MODEL_LOAD_FAILED"
    INFERENCE_FAILED = "INFERENCE_FAILED"
    DATABASE_UNAVAILABLE = "DATABASE_UNAVAILABLE"
    DEVICE_NOT_ENROLLED = "DEVICE_NOT_ENROLLED"
    PHOTOKIT_PERMISSION_DENIED = "PHOTOKIT_PERMISSION_DENIED"
    PHOTOKIT_WRITE_UNAVAILABLE = "PHOTOKIT_WRITE_UNAVAILABLE"
    ASSET_MAPPING_AMBIGUOUS = "ASSET_MAPPING_AMBIGUOUS"
    SYNC_CONFLICT = "SYNC_CONFLICT"
    SYNC_VERIFICATION_FAILED = "SYNC_VERIFICATION_FAILED"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    NOT_FOUND = "NOT_FOUND"
    INVALID_REQUEST = "INVALID_REQUEST"
    RATE_LIMITED = "RATE_LIMITED"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    STORAGE_UNAVAILABLE = "STORAGE_UNAVAILABLE"


class AppError(Exception):
    def __init__(
        self,
        code: str | ErrorCode,
        message: str,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = str(code)
        self.message = message
        self.status_code = status_code
        self.details = details or {}


def error_response(request: Request, exc: AppError) -> JSONResponse:
    sentry_event = getattr(request.state, 'sentry_event_id', None)
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": exc.code,
                "message": exc.message,
                "details": exc.details,
                "correlation_id": getattr(request.state, "correlation_id", None),
                "sentry_event_id": sentry_event,
            }
        },
        headers={
            "Cache-Control": "no-store",
            **({"X-Sentry-Event-ID": sentry_event} if sentry_event else {}),
        },
    )
