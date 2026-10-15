"""Bounded public projections: object keys, secrets and source paths stay private."""

import base64
import json
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import inspect

from photointel.errors import AppError, ErrorCode
from photointel.models import Asset, AssetResource, AssetTag, Tag
from photointel.schemas import AssetOut, AssetTagOut, ResourceOut, TagOut


def row_dict(row: Any, exclude: set[str] | None = None) -> dict[str, Any]:
    excluded = exclude or set()
    return {
        item.key: getattr(row, item.key)
        for item in inspect(type(row)).column_attrs if item.key not in excluded
    }


def asset_out(asset: Asset, ranking: dict[str, Any] | None = None) -> AssetOut:
    data = row_dict(
        asset, {"source_metadata", "source_account", "sha256", "phash",
                "search_document", "missing_scan_count", "updated_at",
                "last_successful_inference"}
    )
    data["thumbnail_url"] = (
        f"/v1/assets/{asset.id}/media/thumbnail_medium"
        if asset.ingestion_status == "completed" and asset.media_type != "video" else None
    )
    data["ranking"] = ranking
    return AssetOut.model_validate(data)


def resource_out(resource: AssetResource) -> ResourceOut:
    data = {
        key: getattr(resource, key)
        for key in ResourceOut.model_fields if key != "media_url"
    }
    data["media_url"] = (
        f"/v1/assets/{resource.asset_id}/media/{resource.resource_type}"
        if resource.status in {"available", "completed"}
        and resource.resource_type != "inference_input" else None
    )
    return ResourceOut.model_validate(data)


def tag_out(tag: Tag, aliases: list[dict[str, Any]] | None = None) -> TagOut:
    return TagOut.model_validate(
        {**row_dict(tag, {"created_at"}), "aliases": aliases or []}
    )


def assertion_out(assertion: AssetTag, tag: Tag) -> AssetTagOut:
    return AssetTagOut(
        id=assertion.id, tag_id=tag.id, canonical_key=tag.canonical_key,
        display_name=tag.display_name, category=tag.category, origin=assertion.origin,
        confidence=assertion.confidence, model_version=assertion.model_version,
        user_status=assertion.user_status, review_status=assertion.review_status,
        is_sensitive=tag.is_sensitive,
    )


def encode_cursor(data: dict[str, Any]) -> str:
    def fallback(value: Any) -> str:
        if isinstance(value, (UUID, datetime)):
            return str(value)
        raise TypeError("Invalid cursor value")
    return base64.urlsafe_b64encode(
        json.dumps(data, default=fallback, separators=(",", ":")).encode()
    ).decode().rstrip("=")


def decode_cursor(cursor: str) -> dict[str, Any]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("Invalid cursor")
        return data
    except (ValueError, TypeError, UnicodeError) as exc:
        raise AppError(ErrorCode.INVALID_REQUEST, "Cursor inválido", 422) from exc
