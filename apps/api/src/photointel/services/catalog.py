"""Transactional user metadata; independent provenance and durable AI rejection."""

from collections.abc import Iterable, Iterator
from itertools import islice
from typing import Any
from uuid import UUID

from sqlalchemy import Uuid, case, delete, func, literal, not_, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.auth import Identity
from photointel.errors import AppError, ErrorCode
from photointel.models import Asset, AssetTag, AuditEvent, Tag, TagAlias
from photointel.schemas import TagEdit

CATEGORIES = (
    "person",
    "body",
    "face_hair",
    "clothing",
    "clothing_bulge",
    "pose_action",
    "sexual_action",
    "genitals",
    "penis",
    "environment",
    "objects",
    "composition",
    "visual",
    "other",
)
SENSITIVE_CATEGORIES = {"sexual_action", "genitals", "penis", "clothing_bulge"}
ASSERTION_BATCH_SIZE = 1000


def assertion_batches(
    asset_ids: Iterable[UUID],
    assertions: dict[UUID, str],
) -> Iterator[list[dict[str, Any]]]:
    """Bound SQL parameters and memory even for the largest allowed bulk action."""
    ordered_assertions = sorted(assertions.items())
    rows = (
        {
            "asset_id": asset_id,
            "tag_id": tag_id,
            "origin": "user",
            "confidence": 1.0,
            "model_version": "",
            "user_status": status,
            "review_status": status,
        }
        for asset_id in asset_ids
        for tag_id, status in ordered_assertions
    )
    while batch := list(islice(rows, ASSERTION_BATCH_SIZE)):
        yield batch


async def get_asset(session: AsyncSession, asset_id: UUID) -> Asset:
    asset = await session.get(Asset, asset_id)
    if not asset:
        raise AppError(ErrorCode.NOT_FOUND, "Foto não encontrada", 404)
    return asset


def audit(
    session: AsyncSession,
    identity: Identity,
    action: str,
    asset_id: UUID | None = None,
    **details: Any,
) -> None:
    session.add(
        AuditEvent(
            actor=identity.subject,
            action=action,
            asset_id=asset_id,
            details=details,
        )
    )


async def refresh_search_document(
    session: AsyncSession,
    asset_ids: list[UUID] | None = None,
    *,
    tag_id: UUID | None = None,
) -> None:
    from photointel.services.search import current_assertion, rejection_exists

    tag_text = (
        select(
            func.string_agg(
                func.concat(Tag.display_name, " ", Tag.canonical_key),
                " ",
            )
        )
        .select_from(AssetTag)
        .join(
            Tag,
            AssetTag.tag_id == Tag.id,
        )
        .where(
            AssetTag.asset_id == Asset.id,
            AssetTag.user_status != "rejected",
            Tag.is_sensitive.is_(False),
            Tag.enabled.is_(True),
            or_(
                AssetTag.confidence.is_(None),
                AssetTag.confidence >= Tag.minimum_confidence,
            ),
            not_(rejection_exists(AssetTag.asset_id, AssetTag.tag_id)),
            current_assertion(),
        )
        .correlate(Asset)
        .scalar_subquery()
    )
    identifiers = (
        asset_ids
        if asset_ids is not None
        else select(AssetTag.asset_id).where(AssetTag.tag_id == tag_id)
    )
    await session.execute(
        update(Asset)
        .where(Asset.id.in_(identifiers))
        .values(
            search_document=func.photointel_filename_document(Asset.filename).op("||")(
                func.to_tsvector("simple", func.coalesce(tag_text, ""))
            )
        )
    )


async def edit_tags(
    session: AsyncSession,
    asset_ids: list[UUID],
    request: TagEdit,
    identity: Identity,
) -> None:
    # One batched identity validation, rather than N round-trips for a bulk action.
    existing_ids = set(
        (await session.scalars(select(Asset.id).where(Asset.id.in_(asset_ids)))).all()
    )
    if set(asset_ids) != existing_ids:
        raise AppError(ErrorCode.NOT_FOUND, "Uma ou mais fotos não existem", 404)
    keys = set(request.add + request.remove)
    for key in keys:
        if not key or len(key) > 255:
            raise AppError(ErrorCode.INVALID_REQUEST, "Keyword inválida", 422)
    # Concurrent requests may introduce the same keyword. The unique constraint,
    # rather than a prior SELECT, decides who creates it without aborting either edit.
    if request.add:
        await session.execute(
            insert(Tag)
            .values(
                [
                    {
                        "canonical_key": key,
                        "display_name": key.replace("_", " "),
                        "category": "other",
                        "minimum_confidence": 0,
                        "sync_eligible": True,
                    }
                    for key in sorted(set(request.add))
                ]
            )
            .on_conflict_do_nothing(index_elements=["canonical_key"])
        )
    tags = list(
        (await session.scalars(select(Tag).where(Tag.canonical_key.in_(keys)))).all()
    )
    tag_by_key = {tag.canonical_key: tag for tag in tags}
    from photointel.services.taxonomy import resolve_tag_targets

    targets = await resolve_tag_targets(session, list(tag_by_key.values()))
    tag_by_key = {key: targets[tag.id] for key, tag in tag_by_key.items()}
    reference_ids = set(request.approve + request.reject)
    found_refs = (
        set(
            (await session.scalars(select(Tag.id).where(Tag.id.in_(reference_ids)))).all()
        )
        if reference_ids
        else set()
    )
    if found_refs != reference_ids:
        raise AppError(ErrorCode.NOT_FOUND, "Tag não encontrada", 404)
    reference_tags = (
        list((await session.scalars(select(Tag).where(Tag.id.in_(reference_ids)))).all())
        if reference_ids
        else []
    )
    reference_targets = await resolve_tag_targets(session, reference_tags)
    assertions: dict[UUID, str] = {tag_by_key[key].id: "approved" for key in request.add}
    assertions.update(
        {reference_targets[identifier].id: "approved" for identifier in request.approve}
    )
    assertions.update(
        {reference_targets[identifier].id: "rejected" for identifier in request.reject}
    )
    for values in assertion_batches(sorted(existing_ids), assertions):
        statement = insert(AssetTag).values(values)
        await session.execute(
            statement.on_conflict_do_update(
                index_elements=["asset_id", "tag_id", "origin", "model_version"],
                set_={
                    "user_status": statement.excluded.user_status,
                    "review_status": statement.excluded.review_status,
                    "confidence": statement.excluded.confidence,
                    "updated_at": func.now(),
                },
            )
        )
    remove_ids = [tag_by_key[key].id for key in request.remove if key in tag_by_key]
    if remove_ids:
        await session.execute(
            delete(AssetTag).where(
                AssetTag.asset_id.in_(asset_ids),
                AssetTag.tag_id.in_(remove_ids),
                AssetTag.origin == "user",
                AssetTag.user_status != "rejected",
            )
        )
    await refresh_search_document(session, asset_ids)
    for asset_id in asset_ids:
        # Audit counts and identifiers; sensitive keywords never enter audit logs.
        audit(
            session,
            identity,
            "asset.tags.edit",
            asset_id,
            added=len(request.add),
            removed=len(request.remove),
            approved=len(request.approve),
            rejected=len(request.reject),
        )


async def merge_tag_assertions(
    session: AsyncSession,
    source: Tag,
    requested_target: Tag,
) -> None:
    """Merge canonical assertions while preserving provenance and user rejections."""
    from photointel.services.taxonomy import resolve_tag_targets

    target = (await resolve_tag_targets(session, [requested_target]))[requested_target.id]
    if source.id == target.id:
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Uma tag não pode ser mesclada consigo", 422
        )
    source.merged_into_id = target.id
    target.is_sensitive = target.is_sensitive or source.is_sensitive
    columns = [
        "id",
        "asset_id",
        "tag_id",
        "origin",
        "confidence",
        "model_version",
        "user_status",
        "review_status",
        "created_at",
        "updated_at",
    ]
    statement = insert(AssetTag).from_select(
        columns,
        select(
            func.gen_random_uuid(),
            AssetTag.asset_id,
            literal(target.id, type_=Uuid()),
            AssetTag.origin,
            AssetTag.confidence,
            AssetTag.model_version,
            AssetTag.user_status,
            AssetTag.review_status,
            AssetTag.created_at,
            AssetTag.updated_at,
        ).where(AssetTag.tag_id == source.id),
        include_defaults=False,
    )
    excluded = statement.excluded
    user_status = case(
        (
            (AssetTag.user_status == "rejected") | (excluded.user_status == "rejected"),
            "rejected",
        ),
        (
            (AssetTag.user_status == "approved") | (excluded.user_status == "approved"),
            "approved",
        ),
        else_=AssetTag.user_status,
    )
    await session.execute(
        statement.on_conflict_do_update(
            index_elements=["asset_id", "tag_id", "origin", "model_version"],
            set_={
                "confidence": func.greatest(AssetTag.confidence, excluded.confidence),
                "user_status": user_status,
                "review_status": user_status,
                "updated_at": func.now(),
            },
        )
    )
    await session.execute(delete(AssetTag).where(AssetTag.tag_id == source.id))
    aliases = insert(TagAlias).from_select(
        ["id", "tag_id", "language", "alias", "alias_type"],
        select(
            func.gen_random_uuid(),
            literal(target.id, type_=Uuid()),
            TagAlias.language,
            TagAlias.alias,
            TagAlias.alias_type,
        ).where(TagAlias.tag_id == source.id),
        include_defaults=False,
    )
    await session.execute(
        aliases.on_conflict_do_nothing(index_elements=["tag_id", "language", "alias"])
    )
    await session.execute(
        insert(TagAlias)
        .values(
            tag_id=target.id,
            language="en",
            alias=source.canonical_key,
            alias_type="merged_key",
        )
        .on_conflict_do_nothing(index_elements=["tag_id", "language", "alias"])
    )
    await refresh_search_document(session, tag_id=target.id)


async def aliases_for(
    session: AsyncSession,
    identifiers: list[UUID],
) -> dict[UUID, list[dict[str, Any]]]:
    results: dict[UUID, list[dict[str, Any]]] = {}
    if not identifiers:
        return results
    for alias in (
        await session.scalars(select(TagAlias).where(TagAlias.tag_id.in_(identifiers)))
    ).all():
        results.setdefault(alias.tag_id, []).append(
            {
                "id": str(alias.id),
                "alias": alias.alias,
                "language": alias.language,
                "alias_type": alias.alias_type,
            }
        )
    return results
