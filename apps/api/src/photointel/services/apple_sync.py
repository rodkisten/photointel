"""Pure keyword safety rules shared by protocol validation and tests.

No Apple write occurs in this module. PhotoKit identifiers are device-specific;
the downloader's identifiers are never treated as PhotoKit cloud identifiers.
"""

import hashlib
import hmac
import json
import unicodedata
from typing import Any

from photointel.errors import AppError, ErrorCode


def keywords(values: list[str]) -> list[str]:
    normalized = {unicodedata.normalize("NFC", value).strip() for value in values}
    if len(values) > 200 or any(len(value) > 255 for value in normalized):
        raise AppError(ErrorCode.INVALID_REQUEST, "Limite de keywords excedido", 422)
    if any(any(ord(char) < 32 for char in value) for value in normalized):
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Keyword contém caracteres inválidos", 422
        )
    return sorted(normalized - {""})


def metadata_revision(values: list[str]) -> str:
    payload = json.dumps(keywords(values), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def credential_digest(token: str, pepper: str = "") -> str:
    if pepper:
        return hmac.new(pepper.encode(), token.encode(), hashlib.sha256).hexdigest()
    # Local-only deployment may omit a pepper. Tokens still contain 256 bits of entropy.
    return hashlib.sha256(token.encode()).hexdigest()


def keyword_delta(
    existing: list[str],
    add: list[str],
    remove: list[str],
    managed: list[str],
    approve_removals: bool = False,
) -> dict[str, Any]:
    before, additions, removals = (
        set(keywords(existing)),
        set(keywords(add)),
        set(keywords(remove)),
    )
    if additions & removals:
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            "Keyword incluída e removida na mesma operação",
            422,
        )
    if removals and not approve_removals:
        raise AppError(ErrorCode.FORBIDDEN, "Remoções exigem aprovação explícita", 403)
    if removals - set(keywords(managed)):
        raise AppError(
            ErrorCode.FORBIDDEN,
            "Keywords Apple não gerenciadas devem ser preservadas",
            403,
        )
    actual_add, actual_remove = sorted(additions - before), sorted(removals & before)
    after = sorted((before | additions) - removals)
    return {
        "before": sorted(before),
        "add": actual_add,
        "remove": actual_remove,
        "after": after,
        "expected_revision": metadata_revision(sorted(before)),
        "desired_revision": metadata_revision(after),
    }


def three_way_merge(
    base: list[str],
    current: list[str],
    add: list[str],
    remove: list[str],
    managed: list[str],
) -> dict[str, Any]:
    """Preserve external additions; reject overlap with concurrent Apple changes.

    A preview rebased to another snapshot still requires a new explicit approval.
    """
    original, observed = set(keywords(base)), set(keywords(current))
    requested_add, requested_remove = set(keywords(add)), set(keywords(remove))
    changed = original ^ observed
    if (requested_add | requested_remove) & changed:
        raise AppError(ErrorCode.SYNC_CONFLICT, "Keywords alteradas simultaneamente", 409)
    return keyword_delta(
        list(observed),
        list(requested_add),
        list(requested_remove),
        managed,
        approve_removals=True,
    )


def assert_verified_mapping(mappings: list[Any]) -> Any:
    if len(mappings) != 1 or mappings[0].verification_status != "verified":
        raise AppError(
            ErrorCode.ASSET_MAPPING_AMBIGUOUS,
            "Confirme uma correspondência única antes de sincronizar",
            409,
        )
    return mappings[0]


def validate_write_receipt(
    payload: dict[str, Any],
    expected_revision: str,
    before: list[str],
    after: list[str],
) -> None:
    if metadata_revision(before) != expected_revision:
        raise AppError(ErrorCode.SYNC_CONFLICT, "Snapshot mudou antes da escrita", 409)
    actual = keyword_delta(
        before,
        payload["add"],
        payload["remove"],
        payload["managed_keywords"],
        approve_removals=payload["approve_removals"],
    )
    if keywords(after) != actual["after"]:
        raise AppError(
            ErrorCode.SYNC_VERIFICATION_FAILED,
            "Leitura após escrita difere da alteração aprovada",
            409,
        )
