"""Authenticated assets, hybrid search, taxonomy, albums and saved queries."""

import asyncio
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import delete, func, not_, or_, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.auth import Identity, require_identity
from photointel.config import get_settings
from photointel.database import get_session
from photointel.errors import AppError, ErrorCode
from photointel.models import (
    Album,
    AlbumAsset,
    Asset,
    AssetMetadata,
    AssetResource,
    AssetTag,
    DeviceMapping,
    DuplicateGroup,
    DuplicateMember,
    InferenceRun,
    ModelRegistry,
    SavedSearch,
    Setting,
    Tag,
    TagAlias,
)
from photointel.schemas import (
    AlbumAssetsInput,
    AlbumCreate,
    AlbumOut,
    AlbumPatch,
    AssetDetailOut,
    AssetOut,
    AssetTagOut,
    BulkTagEdit,
    FilterNode,
    Page,
    ResourceOut,
    RethresholdInput,
    SavedSearchInput,
    SearchPage,
    SearchRequest,
    SimilarRequest,
    TagCreate,
    TagEdit,
    TagOut,
    TagPatch,
)
from photointel.serializers import (
    assertion_out,
    asset_out,
    decode_uuid_cursor,
    encode_cursor,
    resource_out,
    row_dict,
    tag_out,
)
from photointel.services.catalog import (
    CATEGORIES,
    SENSITIVE_CATEGORIES,
    aliases_for,
    audit,
    edit_tags,
    get_asset,
    merge_tag_assertions,
    refresh_search_document,
)
from photointel.services.search import execute_search, rejection_exists, sensitive_visible
from photointel.storage import get_storage

router = APIRouter(dependencies=[Depends(require_identity)])
Session = Annotated[AsyncSession, Depends(get_session)]
Actor = Annotated[Identity, Depends(require_identity)]


@router.get("/assets", response_model=Page[AssetOut], tags=["assets"])
async def assets(
    session: Session,
    limit: int = Query(60, ge=1, le=200),
    cursor: str | None = Query(None, max_length=4096),
    sort: Literal[
        "captured_desc", "added_desc", "quality_desc", "filesize_asc"
    ] = "captured_desc",
    library_id: UUID | None = None,
    album_id: UUID | None = None,
    media_type: Literal["image", "video", "live_photo"] | None = None,
) -> SearchPage:
    children: list[FilterNode] = []
    if library_id:
        children.append(FilterNode(op="source", value=str(library_id)))
    if album_id:
        children.append(FilterNode(op="album", value=str(album_id)))
    if media_type:
        children.append(FilterNode(op="media_type", value=media_type))
    return await execute_search(
        session,
        SearchRequest(
            limit=limit,
            cursor=cursor,
            sort=sort,
            filter=FilterNode(op="and", children=children) if children else None,
        ),
    )


async def tags_for_asset(
    session: AsyncSession,
    asset_id: UUID,
    include_rejected: bool = True,
) -> list[AssetTagOut]:
    query = (
        select(AssetTag, Tag)
        .join(Tag)
        .where(
            AssetTag.asset_id == asset_id,
            Tag.enabled.is_(True),
        )
    )
    if not await sensitive_visible(session):
        query = query.where(Tag.is_sensitive.is_(False))
    if not include_rejected:
        query = query.where(
            AssetTag.user_status != "rejected",
            not_(rejection_exists(AssetTag.asset_id, AssetTag.tag_id)),
        )
    return [
        assertion_out(assertion, tag)
        for assertion, tag in (
            await session.execute(
                query.order_by(Tag.category, Tag.display_name).limit(1000)
            )
        ).all()
    ]


@router.get("/assets/{asset_id}", response_model=AssetDetailOut, tags=["assets"])
async def asset_detail(asset_id: UUID, session: Session) -> AssetDetailOut:
    asset = await get_asset(session, asset_id)
    resources = list(
        (
            await session.scalars(
                select(AssetResource).where(
                    AssetResource.asset_id == asset_id,
                    AssetResource.revision == asset.representation_revision,
                    AssetResource.resource_type != "inference_input",
                )
            )
        ).all()
    )
    metadata = await session.get(AssetMetadata, asset_id)
    runs = (
        await session.execute(
            select(InferenceRun, ModelRegistry)
            .join(ModelRegistry)
            .where(InferenceRun.asset_id == asset_id)
            .order_by(InferenceRun.created_at.desc())
            .limit(20)
        )
    ).all()
    mapping_statuses = list(
        (
            await session.scalars(
                select(DeviceMapping.verification_status)
                .where(DeviceMapping.asset_id == asset_id)
                .limit(20)
            )
        ).all()
    )
    return AssetDetailOut(
        **asset_out(asset).model_dump(),
        metadata=row_dict(metadata) if metadata else None,
        resources=[resource_out(row) for row in resources],
        tags=await tags_for_asset(session, asset_id),
        inference_runs=[
            {
                "id": run.id,
                "model_name": model.model_name,
                "model_revision": model.revision,
                "input_revision": run.input_revision,
                "status": run.status,
                "runtime_ms": run.runtime_ms,
                "completed_at": run.completed_at,
                "error": run.error,
            }
            for run, model in runs
        ],
        mapping_status=(
            "verified"
            if "verified" in mapping_statuses
            else "ambiguous"
            if "ambiguous" in mapping_statuses
            else "unmapped"
        ),
    )


@router.get(
    "/assets/{asset_id}/resources", response_model=list[ResourceOut], tags=["assets"]
)
async def asset_resources(asset_id: UUID, session: Session) -> list[ResourceOut]:
    asset = await get_asset(session, asset_id)
    rows = (
        await session.scalars(
            select(AssetResource)
            .where(
                AssetResource.asset_id == asset_id,
                AssetResource.revision == asset.representation_revision,
                AssetResource.resource_type != "inference_input",
            )
            .limit(30)
        )
    ).all()
    return [resource_out(row) for row in rows]


@router.get("/assets/{asset_id}/metadata", tags=["assets"])
async def asset_metadata(asset_id: UUID, session: Session) -> dict[str, Any]:
    await get_asset(session, asset_id)
    metadata = await session.get(AssetMetadata, asset_id)
    return row_dict(metadata) if metadata else {}


@router.get("/assets/{asset_id}/tags", response_model=list[AssetTagOut], tags=["assets"])
async def asset_tags(
    asset_id: UUID,
    session: Session,
    include_rejected: bool = True,
) -> list[AssetTagOut]:
    await get_asset(session, asset_id)
    return await tags_for_asset(session, asset_id, include_rejected)


@router.patch("/assets/tags", tags=["assets"])
@router.patch("/assets/bulk/tags", tags=["assets"])
async def bulk_asset_tags(
    body: BulkTagEdit,
    session: Session,
    identity: Actor,
) -> dict[str, int]:
    await edit_tags(session, body.asset_ids, body, identity)
    await session.commit()
    return {"updated": len(set(body.asset_ids))}


@router.patch(
    "/assets/{asset_id}/tags", response_model=list[AssetTagOut], tags=["assets"]
)
async def change_asset_tags(
    asset_id: UUID,
    body: TagEdit,
    session: Session,
    identity: Actor,
) -> list[AssetTagOut]:
    await edit_tags(session, [asset_id], body, identity)
    await session.commit()
    return await tags_for_asset(session, asset_id)


@router.get("/assets/{asset_id}/media/{variant}", tags=["media"])
async def asset_media(
    asset_id: UUID,
    variant: Literal["thumbnail_small", "thumbnail_medium", "preview_large"],
    session: Session,
) -> Response:
    asset = await get_asset(session, asset_id)
    resource = await session.scalar(
        select(AssetResource)
        .where(
            AssetResource.asset_id == asset_id,
            AssetResource.resource_type == variant,
            AssetResource.revision == asset.representation_revision,
            AssetResource.status.in_(["available", "completed"]),
        )
        .limit(1)
    )
    if not resource or not resource.object_key:
        raise AppError(
            ErrorCode.NOT_FOUND, "Prévia ainda indisponível; verifique os jobs", 404
        )
    if (resource.byte_size or 0) > get_settings().media_max_bytes:
        raise AppError(ErrorCode.INVALID_REQUEST, "Prévia excede limite de mídia", 413)
    data = await asyncio.to_thread(get_storage().get, resource.object_key)
    if len(data) > get_settings().media_max_bytes:
        raise AppError(ErrorCode.INVALID_REQUEST, "Prévia excede limite de mídia", 413)
    return Response(
        data,
        media_type=resource.mime_type or "image/webp",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/search", response_model=SearchPage, tags=["search"])
async def search(body: SearchRequest, session: Session) -> SearchPage:
    return await execute_search(session, body)


@router.post("/search/similar", response_model=SearchPage, tags=["search"])
async def search_similar(body: SimilarRequest, session: Session) -> SearchPage:
    return await execute_search(
        session,
        SearchRequest(
            source_asset_id=body.asset_id,
            filter=body.filter,
            limit=body.limit,
            sort="relevance",
        ),
    )


@router.get("/assets/{asset_id}/similar", response_model=SearchPage, tags=["assets"])
async def similar(
    asset_id: UUID, session: Session, limit: int = Query(30, ge=1, le=100)
) -> SearchPage:
    await get_asset(session, asset_id)
    return await execute_search(
        session,
        SearchRequest(
            source_asset_id=asset_id,
            sort="relevance",
            limit=limit,
        ),
    )


@router.get("/search/suggestions", tags=["search"])
async def suggestions(
    session: Session, q: str = Query("", max_length=100)
) -> dict[str, Any]:
    query = (
        select(Tag)
        .outerjoin(TagAlias)
        .where(
            or_(
                Tag.display_name.ilike(f"%{q}%"),
                Tag.canonical_key.ilike(f"%{q}%"),
                TagAlias.alias.ilike(f"%{q}%"),
            ),
            Tag.enabled.is_(True),
        )
    )
    if not await sensitive_visible(session):
        query = query.where(Tag.is_sensitive.is_(False))
    rows = (
        await session.scalars(query.distinct().order_by(Tag.display_name).limit(20))
    ).all()
    return {"items": [tag_out(tag) for tag in rows], "next_cursor": None}


@router.get("/search/facets", tags=["search"])
async def facets(session: Session) -> dict[str, Any]:
    media = (
        await session.execute(
            select(Asset.media_type, func.count(Asset.id)).group_by(Asset.media_type)
        )
    ).all()
    sources = (
        await session.execute(
            select(Asset.library_id, func.count(Asset.id)).group_by(Asset.library_id)
        )
    ).all()
    bounds = (
        await session.execute(
            select(
                func.min(Asset.captured_at),
                func.max(Asset.captured_at),
                func.max(Asset.filesize),
                func.max(Asset.width),
                func.max(Asset.height),
            )
        )
    ).one()
    return {
        "media_types": [{"value": value, "count": count} for value, count in media],
        "sources": [
            {"value": identifier, "count": count} for identifier, count in sources
        ],
        "date_min": bounds[0],
        "date_max": bounds[1],
        "max_filesize": bounds[2],
        "max_width": bounds[3],
        "max_height": bounds[4],
        "people_count": {"state": "not_implemented", "reason": "Detector não está no v1"},
    }


@router.get("/tags", response_model=Page[TagOut], tags=["taxonomy"])
async def tags(
    session: Session,
    q: str = Query("", max_length=100),
    category: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    cursor: str | None = Query(None, max_length=4096),
) -> Page[TagOut]:
    query = select(Tag).where(
        or_(
            Tag.display_name.ilike(f"%{q}%"),
            Tag.canonical_key.ilike(f"%{q}%"),
        )
    )
    if category:
        query = query.where(Tag.category == category)
    if not await sensitive_visible(session):
        query = query.where(Tag.is_sensitive.is_(False))
    if cursor:
        query = query.where(Tag.id > decode_uuid_cursor(cursor))
    rows = list((await session.scalars(query.order_by(Tag.id).limit(limit + 1))).all())
    alias_map = await aliases_for(session, [tag.id for tag in rows[:limit]])
    return Page(
        items=[tag_out(tag, alias_map.get(tag.id)) for tag in rows[:limit]],
        next_cursor=encode_cursor({"id": rows[limit - 1].id})
        if len(rows) > limit
        else None,
    )


@router.get("/tags/categories", tags=["taxonomy"])
async def tag_categories(session: Session) -> dict[str, Any]:
    from photointel.services.runtime_settings import effective_settings
    from photointel.services.taxonomy import CATEGORIES as names

    settings = await effective_settings(session)
    stored = await session.get(Setting, "taxonomy_categories")
    rules = stored.value if stored else {}
    counts = {
        category: count
        for category, count in (
            await session.execute(
                select(Tag.category, func.count(Tag.id)).group_by(Tag.category)
            )
        ).all()
    }
    visible = await sensitive_visible(session)
    return {
        "items": [
            {
                "key": key,
                "name": names[key],
                "count": counts.get(key, 0),
                "is_sensitive": key in SENSITIVE_CATEGORIES,
                "enabled": rules.get(key, {}).get("enabled", True),
                "minimum_confidence": rules.get(key, {}).get(
                    "minimum_confidence",
                    settings.joytag_threshold,
                ),
            }
            for key in CATEGORIES
            if visible or key not in SENSITIVE_CATEGORIES
        ],
        "next_cursor": None,
    }


@router.get("/tags/aliases", tags=["taxonomy"])
async def tag_aliases(
    session: Session,
    tag_id: UUID | None = None,
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    query = select(TagAlias).join(Tag)
    if tag_id:
        query = query.where(TagAlias.tag_id == tag_id)
    if not await sensitive_visible(session):
        query = query.where(Tag.is_sensitive.is_(False))
    return {
        "items": [
            row_dict(row)
            for row in (
                await session.scalars(query.order_by(TagAlias.id).limit(limit))
            ).all()
        ],
        "next_cursor": None,
    }


@router.post("/tags", response_model=TagOut, status_code=201, tags=["taxonomy"])
async def create_tag(body: TagCreate, session: Session, identity: Actor) -> TagOut:
    if body.category not in CATEGORIES:
        raise AppError(ErrorCode.INVALID_REQUEST, "Categoria inválida", 422)
    values = body.model_dump()
    values["is_sensitive"] = body.is_sensitive or body.category in SENSITIVE_CATEGORIES
    tag = await session.scalar(
        insert(Tag)
        .values(
            **values,
            minimum_confidence=0,
        )
        .on_conflict_do_nothing(index_elements=["canonical_key"])
        .returning(Tag)
    )
    if tag is None:
        raise AppError(ErrorCode.INVALID_REQUEST, "Keyword já existe", 409)
    audit(session, identity, "tag.create", tag_id=str(tag.id))
    await session.commit()
    return tag_out(tag)


@router.post("/tags/rethreshold", tags=["taxonomy"])
async def rethreshold(
    body: RethresholdInput,
    session: Session,
    identity: Actor,
) -> dict[str, int]:
    from photointel.services.inference import rethreshold_assets
    from photointel.services.runtime_settings import effective_settings

    result = await rethreshold_assets(
        session,
        body.asset_ids,
        await effective_settings(session),
    )
    audit(session, identity, "tags.rethreshold", assets=len(body.asset_ids))
    await session.commit()
    return result


@router.patch("/tags/{tag_id}", response_model=TagOut, tags=["taxonomy"])
async def update_tag(
    tag_id: UUID,
    body: TagPatch,
    session: Session,
    identity: Actor,
) -> TagOut:
    # A single source-row lock would permit concurrent A→B and B→A merges.
    await session.execute(text("SELECT pg_advisory_xact_lock(734682103)"))
    tag = await session.get(Tag, tag_id)
    if not tag:
        raise AppError(ErrorCode.NOT_FOUND, "Tag não encontrada", 404)
    if body.category is not None and body.category not in CATEGORIES:
        raise AppError(ErrorCode.INVALID_REQUEST, "Categoria inválida", 422)
    for field, relation in (
        ("parent_id", body.parent_id),
        ("merged_into_id", body.merged_into_id),
    ):
        if relation:
            seen = {tag_id}
            current = relation
            for _ in range(64):
                if current in seen:
                    raise AppError(
                        ErrorCode.INVALID_REQUEST, "Hierarquia de tags contém ciclo", 422
                    )
                seen.add(current)
                parent = await session.get(Tag, current)
                if not parent:
                    raise AppError(
                        ErrorCode.NOT_FOUND, "Tag de destino não encontrada", 404
                    )
                next_id = getattr(parent, field)
                if not next_id:
                    break
                current = next_id
            else:
                raise AppError(ErrorCode.INVALID_REQUEST, "Hierarquia excede limite", 422)
    for key, value in body.model_dump(exclude_unset=True, exclude={"aliases"}).items():
        setattr(tag, key, value)
    if tag.category in SENSITIVE_CATEGORIES:
        tag.is_sensitive = True
    if body.merged_into_id:
        target = await session.get(Tag, body.merged_into_id)
        if target:
            await merge_tag_assertions(session, tag, target)
    if body.aliases is not None:
        await session.execute(delete(TagAlias).where(TagAlias.tag_id == tag_id))
        for alias in body.aliases:
            session.add(TagAlias(tag_id=tag_id, **alias.model_dump()))
    # Flush changed visibility before rebuilding full-text terms: newly sensitive
    # labels must not remain searchable in a stale, previously public document.
    await session.flush()
    await refresh_search_document(session, tag_id=tag_id)
    audit(
        session,
        identity,
        "tag.update",
        tag_id=str(tag.id),
        fields=list(body.model_fields_set),
    )
    await session.commit()
    alias_map = await aliases_for(session, [tag_id])
    return tag_out(tag, alias_map.get(tag_id))


async def album_output(session: AsyncSession, album: Album) -> AlbumOut:
    count = await session.scalar(
        select(func.count())
        .select_from(AlbumAsset)
        .where(AlbumAsset.album_id == album.id)
    )
    cover = album.cover_asset_id
    if not cover:
        cover = await session.scalar(
            select(AlbumAsset.asset_id)
            .where(AlbumAsset.album_id == album.id)
            .order_by(AlbumAsset.added_at)
            .limit(1)
        )
    return AlbumOut(
        **row_dict(album),
        asset_count=count or 0,
        cover_url=f"/v1/assets/{cover}/media/thumbnail_medium" if cover else None,
    )


@router.get("/albums", response_model=Page[AlbumOut], tags=["albums"])
async def albums(
    session: Session,
    q: str = Query("", max_length=100),
    limit: int = Query(100, ge=1, le=200),
    cursor: str | None = Query(None, max_length=4096),
) -> Page[AlbumOut]:
    query = select(Album).where(Album.name.ilike(f"%{q}%"))
    if cursor:
        query = query.where(Album.id > decode_uuid_cursor(cursor))
    rows = list((await session.scalars(query.order_by(Album.id).limit(limit + 1))).all())
    # At most 200 albums; asset gallery itself always uses cursor pagination.
    return Page(
        items=[await album_output(session, album) for album in rows[:limit]],
        next_cursor=encode_cursor({"id": rows[limit - 1].id})
        if len(rows) > limit
        else None,
    )


@router.post("/albums", response_model=AlbumOut, status_code=201, tags=["albums"])
async def create_album(body: AlbumCreate, session: Session, identity: Actor) -> AlbumOut:
    album = Album(**body.model_dump())
    session.add(album)
    await session.flush()
    audit(session, identity, "album.create", album_id=str(album.id))
    await session.commit()
    return await album_output(session, album)


@router.get("/albums/{album_id}", response_model=AlbumOut, tags=["albums"])
async def get_album(album_id: UUID, session: Session) -> AlbumOut:
    album = await session.get(Album, album_id)
    if not album:
        raise AppError(ErrorCode.NOT_FOUND, "Álbum não encontrado", 404)
    return await album_output(session, album)


@router.patch("/albums/{album_id}", response_model=AlbumOut, tags=["albums"])
async def update_album(
    album_id: UUID,
    body: AlbumPatch,
    session: Session,
    identity: Actor,
) -> AlbumOut:
    album = await session.get(Album, album_id)
    if not album:
        raise AppError(ErrorCode.NOT_FOUND, "Álbum não encontrado", 404)
    if body.cover_asset_id:
        await get_asset(session, body.cover_asset_id)
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(album, key, value)
    audit(session, identity, "album.update", album_id=str(album.id))
    await session.commit()
    return await album_output(session, album)


@router.post("/albums/{album_id}/assets", tags=["albums"])
async def add_album_assets(
    album_id: UUID,
    body: AlbumAssetsInput,
    session: Session,
    identity: Actor,
) -> dict[str, int]:
    if not await session.get(Album, album_id):
        raise AppError(ErrorCode.NOT_FOUND, "Álbum não encontrado", 404)
    identifiers = set(body.asset_ids)
    count = await session.scalar(
        select(func.count()).select_from(Asset).where(Asset.id.in_(identifiers))
    )
    if count != len(identifiers):
        raise AppError(ErrorCode.NOT_FOUND, "Foto não encontrada", 404)
    await session.execute(
        insert(AlbumAsset)
        .values(
            [{"album_id": album_id, "asset_id": asset_id} for asset_id in identifiers]
        )
        .on_conflict_do_nothing(index_elements=["album_id", "asset_id"])
    )
    audit(
        session,
        identity,
        "album.assets.add",
        album_id=str(album_id),
        assets=len(identifiers),
    )
    await session.commit()
    return {"added": len(identifiers)}


@router.delete("/albums/{album_id}/assets/{asset_id}", status_code=204, tags=["albums"])
async def remove_album_asset(
    album_id: UUID,
    asset_id: UUID,
    session: Session,
    identity: Actor,
) -> Response:
    await session.execute(
        delete(AlbumAsset).where(
            AlbumAsset.album_id == album_id,
            AlbumAsset.asset_id == asset_id,
        )
    )
    audit(session, identity, "album.assets.remove", asset_id, album_id=str(album_id))
    await session.commit()
    return Response(status_code=204)


@router.get("/saved-searches", tags=["search"])
async def saved_searches(session: Session) -> dict[str, Any]:
    return {
        "items": [
            row_dict(row)
            for row in (
                await session.scalars(
                    select(SavedSearch).order_by(SavedSearch.created_at.desc()).limit(200)
                )
            ).all()
        ],
        "next_cursor": None,
    }


@router.post("/saved-searches", status_code=201, tags=["search"])
async def save_search(
    body: SavedSearchInput,
    session: Session,
    identity: Actor,
) -> dict[str, Any]:
    saved = SavedSearch(name=body.name, query=body.query.model_dump(mode="json"))
    session.add(saved)
    await session.flush()
    audit(session, identity, "search.save", search_id=str(saved.id))
    await session.commit()
    return row_dict(saved)


@router.delete("/saved-searches/{search_id}", status_code=204, tags=["search"])
async def delete_saved_search(
    search_id: UUID, session: Session, identity: Actor
) -> Response:
    await session.execute(delete(SavedSearch).where(SavedSearch.id == search_id))
    audit(session, identity, "search.remove", search_id=str(search_id))
    await session.commit()
    return Response(status_code=204)


async def duplicate_outputs(
    session: AsyncSession,
    groups: list[DuplicateGroup],
    threshold: float = 0,
) -> list[dict[str, Any]]:
    if not groups:
        return []
    members = (
        await session.execute(
            select(DuplicateMember, Asset)
            .join(Asset)
            .where(
                DuplicateMember.group_id.in_([group.id for group in groups]),
                DuplicateMember.similarity >= threshold,
            )
            .order_by(
                DuplicateMember.quality_rank.asc().nullslast(),
                Asset.id,
            )
            .limit(1000)
        )
    ).all()
    by_group: dict[UUID, list[dict[str, Any]]] = {}
    for member, asset in members:
        by_group.setdefault(member.group_id, []).append(
            {
                "asset": asset_out(asset),
                "asset_id": asset.id,
                "similarity": member.similarity,
                "quality_rank": member.quality_rank,
            }
        )
    return [
        {
            **row_dict(group),
            "members": by_group.get(group.id, []),
            "safety": "Ações alteram apenas o catálogo; nenhuma exclusão é implementada.",
        }
        for group in groups
        if len(by_group.get(group.id, [])) > 1
    ]


@router.get("/duplicates", tags=["duplicates"])
async def duplicates(
    session: Session,
    threshold: float = Query(0, ge=0, le=1),
    kind: Literal["exact", "near", "all"] = "all",
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(None, max_length=4096),
) -> dict[str, Any]:
    query = select(DuplicateGroup)
    if kind != "all":
        query = query.where(DuplicateGroup.duplicate_type == kind)
    if cursor:
        query = query.where(DuplicateGroup.id > decode_uuid_cursor(cursor))
    groups = list(
        (await session.scalars(query.order_by(DuplicateGroup.id).limit(limit + 1))).all()
    )
    return {
        "items": await duplicate_outputs(session, groups[:limit], threshold),
        "next_cursor": encode_cursor({"id": groups[limit - 1].id})
        if len(groups) > limit
        else None,
    }


@router.get("/assets/{asset_id}/duplicates", tags=["assets"])
async def asset_duplicates(asset_id: UUID, session: Session) -> dict[str, Any]:
    await get_asset(session, asset_id)
    groups = list(
        (
            await session.scalars(
                select(DuplicateGroup)
                .join(DuplicateMember)
                .where(DuplicateMember.asset_id == asset_id)
                .limit(30)
            )
        ).all()
    )
    return {"items": await duplicate_outputs(session, groups), "next_cursor": None}


@router.get("/libraries", tags=["ingestion"])
async def libraries(session: Session) -> dict[str, Any]:
    from photointel.models import Library

    rows = (
        await session.scalars(select(Library).order_by(Library.created_at).limit(100))
    ).all()
    return {
        "items": [row_dict(row, {"configuration", "source_identifier"}) for row in rows],
        "next_cursor": None,
    }
