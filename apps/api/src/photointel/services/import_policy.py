"""Authorize bounded imports once and preserve that decision across executions."""

from typing import Any, cast

from photointel.config import Settings
from photointel.errors import AppError, ErrorCode


def authorize_import(
    settings: Settings, requested: int, confirmed: bool
) -> dict[str, Any]:
    default = min(settings.initial_import_limit, settings.ingestion_import_limit)
    if isinstance(requested, bool) or requested < 1:
        raise AppError(ErrorCode.INVALID_REQUEST, "Limite deve ser positivo", 422)
    if requested > settings.hard_import_limit:
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Limite absoluto de importação excedido", 422
        )
    if requested > settings.maximum_authorized_import_limit:
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            "Amplie primeiro o limite autorizado pelo operador",
            422,
        )
    if requested > default and not confirmed:
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Confirme expansão do limite inicial", 409
        )
    return {
        "default_import_limit": default,
        "maximum_authorized_import_limit": settings.maximum_authorized_import_limit,
        "hard_import_limit": settings.hard_import_limit,
        "confirmed_expansion": confirmed,
        "requested_batch_limit": requested,
    }


def validate_execution(settings: Settings, authorization: dict[str, Any]) -> int:
    """Fail explicitly if policy changed; never silently clamp an approved batch."""
    keys = (
        "default_import_limit",
        "maximum_authorized_import_limit",
        "hard_import_limit",
        "requested_batch_limit",
    )
    values = [authorization.get(key) for key in keys]
    if any(type(value) is not int or value < 1 for value in values):
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Autorização de importação inválida", 422
        )
    default, maximum, hard, requested = (cast(int, value) for value in values)
    confirmed = authorization.get("confirmed_expansion")
    if (
        type(confirmed) is not bool
        or not default <= maximum <= hard
        or requested > min(maximum, hard)
        or (requested > default and not confirmed)
        or requested > settings.maximum_authorized_import_limit
        or requested > settings.hard_import_limit
    ):
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            "Autorização revogada ou incompatível; solicite novamente o lote",
            409,
        )
    return requested
