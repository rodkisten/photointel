"""Transactional user metadata; independent provenance and durable AI rejection."""

from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, not_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.auth import Identity
from photointel.errors import AppError, ErrorCode
from photointel.models import Asset, AssetTag, AuditEvent, Tag, TagAlias
from photointel.schemas import TagEdit

CATEGORIES = (
    "person", "body", "face_hair", "clothing", "clothing_bulge", "pose_action",
    "sexual_action", "genitals", "penis", "environment", "objects", "composition",
    "visual", "other",
)
SENSITIVE_CATEGORIES = {"sexual_action", "genitals", "penis", "clothing_bulge"}


async def get_asset(session: AsyncSession, asset_id: UUID) -> Asset:
    asset = await session.get(Asset, asset_id)
    if not asset:
        raise AppError(ErrorCode.NOT_FOUND, "Foto não encontrada", 404)
    return asset


def audit(
    session: AsyncSession, identity: Identity, action: str,
    asset_id: UUID | None = None, **details: Any,
) -> None:
    session.add(AuditEvent(
        actor=identity.subject, action=action, asset_id=asset_id, details=details,
    ))


async def refresh_search_document(session: AsyncSession, asset_ids: list[UUID]) -> None:
    from photointel.services.search import rejection_exists
    tag_text = select(func.string_agg(Tag.display_name, " ")).select_from(AssetTag).join(
        Tag, AssetTag.tag_id == Tag.id,
    ).where(
        AssetTag.asset_id == Asset.id, AssetTag.user_status != "rejected",
        Tag.is_sensitive.is_(False), Tag.enabled.is_(True),
        not_(rejection_exists(AssetTag.asset_id, AssetTag.tag_id)),
    ).correlate(Asset).scalar_subquery()
    await session.execute(update(Asset).where(Asset.id.in_(asset_ids)).values(
        search_document=func.to_tsvector(
            "simple", func.concat(Asset.filename, " ", func.coalesce(tag_text, "")),
        )
    ))


async def edit_tags(
    session: AsyncSession, asset_ids: list[UUID], request: TagEdit, identity: Identity,
) -> None:
    # One batched identity validation, rather than N round-trips for a bulk action.
    existing_ids = set((await session.scalars(
        select(Asset.id).where(Asset.id.in_(asset_ids))
    )).all())
    if set(asset_ids) != existing_ids:
        raise AppError(ErrorCode.NOT_FOUND, "Uma ou mais fotos não existem", 404)
    keys = set(request.add + request.remove)
    for key in keys:
        if not key or len(key) > 255:
            raise AppError(ErrorCode.INVALID_REQUEST, "Keyword inválida", 422)
    tags = list((await session.scalars(select(Tag).where(Tag.canonical_key.in_(keys)))).all())
    tag_by_key = {tag.canonical_key: tag for tag in tags}
    for key in request.add:
        if key not in tag_by_key:
            tag = Tag(
                canonical_key=key, display_name=key.replace("_", " "), category="other",
                minimum_confidence=0, sync_eligible=True,
            )
            session.add(tag)
            await session.flush()
            tag_by_key[key] = tag
    reference_ids = set(request.approve + request.reject)
    found_refs = set((await session.scalars(select(Tag.id).where(Tag.id.in_(
        reference_ids
    )))).all()) if reference_ids else set()
    if found_refs != reference_ids:
        raise AppError(ErrorCode.NOT_FOUND, "Tag não encontrada", 404)
    assertions: dict[UUID, str] = {
        tag_by_key[key].id: "approved" for key in request.add
    }
    assertions.update({identifier: "approved" for identifier in request.approve})
    assertions.update({identifier: "rejected" for identifier in request.reject})
    values = [
        {
            "asset_id": asset_id, "tag_id": tag_id, "origin": "user",
            "confidence": 1.0, "model_version": "", "user_status": status,
            "review_status": status,
        }
        for asset_id in existing_ids for tag_id, status in assertions.items()
    ]
    if values:
        statement = insert(AssetTag).values(values)
        await session.execute(statement.on_conflict_do_update(
            index_elements=["asset_id", "tag_id", "origin", "model_version"],
            set_={
                "user_status": statement.excluded.user_status,
                "review_status": statement.excluded.review_status,
                "confidence": statement.excluded.confidence, "updated_at": func.now(),
            },
        ))
    remove_ids = [tag_by_key[key].id for key in request.remove if key in tag_by_key]
    if remove_ids:
        await session.execute(delete(AssetTag).where(
            AssetTag.asset_id.in_(asset_ids), AssetTag.tag_id.in_(remove_ids),
            AssetTag.origin == "user", AssetTag.user_status != "rejected",
        ))
    await refresh_search_document(session, asset_ids)
    for asset_id in asset_ids:
        # Audit counts and identifiers; sensitive keywords never enter audit logs.
        audit(session, identity, "asset.tags.edit", asset_id,
              added=len(request.add), removed=len(request.remove),
              approved=len(request.approve), rejected=len(request.reject))


async def aliases_for(
    session: AsyncSession, identifiers: list[UUID],
) -> dict[UUID, list[dict[str, Any]]]:
    results: dict[UUID, list[dict[str, Any]]] = {}
    if not identifiers:
        return results
    for alias in (await session.scalars(
        select(TagAlias).where(TagAlias.tag_id.in_(identifiers))
    )).all():
        results.setdefault(alias.tag_id, []).append({
            "id": str(alias.id), "alias": alias.alias, "language": alias.language,
            "alias_type": alias.alias_type,
        })
    return results
