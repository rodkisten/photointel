"""Parameterized PostgreSQL hybrid retrieval with bounded recursive filter AST."""

import hashlib
import json
from datetime import UTC, datetime
from math import isfinite
from typing import Any
from uuid import UUID

from sqlalchemy import and_, exists, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql.elements import ColumnElement

from photointel.errors import AppError, ErrorCode
from photointel.models import (
    AlbumAsset,
    Asset,
    AssetTag,
    DuplicateMember,
    Embedding,
    ModelRegistry,
    Setting,
    Tag,
    TagAlias,
)
from photointel.schemas import FilterNode, SearchPage, SearchRequest
from photointel.serializers import asset_out, decode_cursor, encode_cursor


async def sensitive_visible(session: AsyncSession) -> bool:
    from photointel.config import get_settings

    setting = await session.get(Setting, "sensitive_tags_visible")
    return bool(setting.value) if setting else get_settings().sensitive_tags_visible


def comparison(column: Any, operator: str, value: Any) -> ColumnElement[bool]:
    operations = {
        "eq": column.__eq__,
        "ne": column.__ne__,
        "lt": column.__lt__,
        "lte": column.__le__,
        "gt": column.__gt__,
        "gte": column.__ge__,
    }
    return operations[operator](value)


def rejection_exists(asset_id: Any, tag_id: Any) -> Any:
    rejection = aliased(AssetTag)
    return exists(
        select(rejection.id).where(
            rejection.asset_id == asset_id,
            rejection.tag_id == tag_id,
            rejection.origin == "user",
            rejection.user_status == "rejected",
        )
    )


def current_assertion() -> Any:
    return or_(
        AssetTag.origin != "joytag",
        exists(
            select(ModelRegistry.id).where(
                ModelRegistry.active.is_(True),
                ModelRegistry.model_name == "fancyfeast/joytag",
                ModelRegistry.revision == AssetTag.model_version,
            )
        ),
    )


def canonical_tag_ids(value: str) -> Any:
    match_alias = exists(
        select(TagAlias.id).where(
            TagAlias.tag_id == Tag.id,
            func.lower(TagAlias.alias) == value.casefold(),
        )
    )
    chain = (
        select(Tag.id, Tag.merged_into_id)
        .where(
            or_(
                Tag.canonical_key == value,
                match_alias,
            )
        )
        .cte(recursive=True)
    )
    target = aliased(Tag)
    # UNION deduplicates repeated nodes, so malformed historical merge cycles
    # cannot turn a bounded search request into an unending recursive query.
    chain = chain.union(
        select(target.id, target.merged_into_id).join(
            chain,
            target.id == chain.c.merged_into_id,
        )
    )
    return select(chain.c.id).where(chain.c.merged_into_id.is_(None))


def date_value(value: Any) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed
    except (ValueError, TypeError) as exc:
        raise AppError(ErrorCode.INVALID_REQUEST, "Data de filtro inválida", 422) from exc


def uuid_value(value: Any) -> UUID:
    try:
        return UUID(str(value))
    except ValueError as exc:
        raise AppError(
            ErrorCode.INVALID_REQUEST, "Identificador de filtro inválido", 422
        ) from exc


def filter_expression(node: FilterNode, show_sensitive: bool = False) -> Any:
    if node.op == "and":
        return and_(
            *(filter_expression(child, show_sensitive) for child in node.children)
        )
    if node.op == "or":
        return or_(*(filter_expression(child, show_sensitive) for child in node.children))
    if node.op == "not":
        return not_(filter_expression(node.children[0], show_sensitive))
    if node.op == "tag":
        conditions = [
            AssetTag.asset_id == Asset.id,
            AssetTag.tag_id == Tag.id,
            Tag.id.in_(canonical_tag_ids(str(node.value))),
            Tag.enabled.is_(True),
            AssetTag.user_status != "rejected",
            current_assertion(),
            not_(rejection_exists(AssetTag.asset_id, AssetTag.tag_id)),
            or_(
                AssetTag.confidence.is_(None),
                AssetTag.confidence
                >= func.greatest(node.confidence, Tag.minimum_confidence),
            ),
        ]
        if not show_sensitive:
            conditions.append(Tag.is_sensitive.is_(False))
        if node.origin:
            conditions.append(AssetTag.origin == node.origin)
        return exists(select(AssetTag.id).join(Tag).where(*conditions))
    if node.op == "text":
        # Search is parameterized and never executes SQL from a user's query.
        return or_(
            Asset.search_document.op("@@")(
                func.websearch_to_tsquery("simple", node.value)
            ),
            Asset.filename.ilike(
                f"%{str(node.value).replace('%', '').replace('_', '')}%"
            ),
        )
    if node.op in {"date", "number", "quality"}:
        if node.op == "quality":
            column = Asset.quality[str(node.key)].as_float()
        else:
            column = getattr(Asset, str(node.key))
        clauses: list[Any] = []
        converter = date_value if node.op == "date" else float
        try:
            if node.minimum is not None:
                clauses.append(column >= converter(node.minimum))
            if node.maximum is not None:
                clauses.append(column <= converter(node.maximum))
            if node.value is not None:
                clauses.append(comparison(column, node.comparison, converter(node.value)))
        except (TypeError, ValueError) as exc:
            raise AppError(
                ErrorCode.INVALID_REQUEST, "Valor numérico inválido", 422
            ) from exc
        return and_(*clauses)
    if node.op == "media_type":
        return Asset.media_type == node.value
    if node.op == "source":
        return Asset.library_id == uuid_value(node.value)
    if node.op == "album":
        return exists(
            select(AlbumAsset.asset_id).where(
                AlbumAsset.asset_id == Asset.id,
                AlbumAsset.album_id == uuid_value(node.value),
            )
        )
    if node.op == "duplicate":
        expression = exists(
            select(DuplicateMember.asset_id).where(DuplicateMember.asset_id == Asset.id)
        )
        return expression if node.value is not False else not_(expression)
    if node.op == "screenshots":
        expression = Asset.source_metadata["is_screenshot"].as_boolean().is_(True)
        return expression if node.value is not False else not_(expression)
    raise AppError(ErrorCode.INVALID_REQUEST, "Filtro não reconhecido", 422)


async def semantic_vector(
    session: AsyncSession,
    request: SearchRequest,
) -> tuple[list[float], ModelRegistry]:
    from photointel.services.runtime_settings import effective_settings

    settings = await effective_settings(session)
    model = await session.scalar(
        select(ModelRegistry)
        .where(
            ModelRegistry.active.is_(True),
            ModelRegistry.model_name == settings.siglip_model_id,
            ModelRegistry.revision == settings.siglip_model_revision,
            ModelRegistry.embedding_dimension.is_not(None),
        )
        .limit(1)
    )
    if not model:
        raise AppError(
            ErrorCode.GPU_UNAVAILABLE,
            "Busca semântica requer modelo SigLIP 2 configurado e embeddings indexados",
            503,
        )
    if request.source_asset_id:
        vector = await session.scalar(
            select(Embedding.vector)
            .join(Asset, Embedding.asset_id == Asset.id)
            .where(
                Embedding.asset_id == request.source_asset_id,
                Embedding.model_id == model.id,
                Embedding.input_revision == Asset.representation_revision,
                Asset.visibility_status != "archived",
            )
            .limit(1)
        )
        if vector is None:
            raise AppError(
                ErrorCode.NOT_FOUND, "Foto ainda não tem embedding compatível", 404
            )
        return [float(item) for item in vector], model
    from photointel.services.inference import embed_text

    result = await embed_text(str(request.query), settings=settings)
    if result.model_revision != model.revision:
        raise AppError(
            ErrorCode.INFERENCE_FAILED,
            "Versões do embedding de texto e imagem diferem",
            409,
        )
    return result.embedding, model


async def execute_search(session: AsyncSession, request: SearchRequest) -> SearchPage:
    show_sensitive = await sensitive_visible(session)
    condition = (
        filter_expression(request.filter, show_sensitive) if request.filter else True
    )
    base_conditions: list[Any] = [Asset.visibility_status != "archived", condition]
    query = select(Asset)
    model_revision: str | None = None
    is_semantic = bool(request.query or request.source_asset_id)
    if is_semantic:
        vector, model = await semantic_vector(session, request)
        distance = Embedding.vector.cosine_distance(vector)
        model_revision = model.revision
        query = query.add_columns(distance.label("distance")).join(
            Embedding,
            and_(
                Embedding.asset_id == Asset.id,
                Embedding.model_id == model.id,
                Embedding.input_revision == Asset.representation_revision,
            ),
        )
        if request.source_asset_id:
            base_conditions.append(Asset.id != request.source_asset_id)
        base_conditions.append(distance <= 1 - request.minimum_similarity)
        sort_column = distance
        descending = False
    else:
        epoch = datetime(1970, 1, 1, tzinfo=UTC)
        sort_columns = {
            "captured_desc": func.coalesce(Asset.captured_at, Asset.created_at, epoch),
            "added_desc": func.coalesce(Asset.added_at, Asset.created_at, epoch),
            "quality_desc": func.coalesce(Asset.quality["score"].as_float(), 0),
            "filesize_asc": func.coalesce(Asset.filesize, 0),
            "relevance": func.coalesce(Asset.captured_at, Asset.created_at, epoch),
        }
        sort_column = sort_columns[request.sort]
        descending = request.sort != "filesize_asc"
        query = query.add_columns(sort_column.label("sort_value"))
    signature_data = request.model_dump(mode="json", exclude={"cursor", "limit"})
    signature = hashlib.sha256(
        json.dumps(signature_data, sort_keys=True).encode()
    ).hexdigest()[:24]
    if request.cursor:
        cursor = decode_cursor(request.cursor)
        if cursor.get("signature") != signature:
            raise AppError(
                ErrorCode.INVALID_REQUEST, "Cursor pertence a outra busca", 422
            )
        last_id = uuid_value(cursor.get("id"))
        last_value: Any = cursor.get("value")
        if not is_semantic and request.sort in {
            "captured_desc",
            "added_desc",
            "relevance",
        }:
            last_value = date_value(last_value)
        elif last_value is not None:
            try:
                last_value = float(last_value)
                if not isfinite(last_value):
                    raise ValueError("Non-finite cursor value")
            except (TypeError, ValueError) as exc:
                raise AppError(ErrorCode.INVALID_REQUEST, "Cursor inválido", 422) from exc
        else:
            raise AppError(ErrorCode.INVALID_REQUEST, "Cursor inválido", 422)
        base_conditions.append(
            or_(
                sort_column < last_value if descending else sort_column > last_value,
                and_(sort_column == last_value, Asset.id > last_id),
            )
        )
    query = (
        query.where(*base_conditions)
        .order_by(
            sort_column.desc() if descending else sort_column.asc(),
            Asset.id.asc(),
        )
        .limit(request.limit + 1)
    )
    results = (await session.execute(query)).all()
    visible = results[: request.limit]
    items = [
        asset_out(
            row[0],
            ranking={
                "semantic_similarity": round(1 - float(row[1]), 5)
                if is_semantic
                else None,
                "exact_filters_applied": request.filter is not None,
            },
        )
        for row in visible
    ]
    next_cursor = None
    if len(results) > request.limit and visible:
        last = visible[-1]
        next_cursor = encode_cursor(
            {
                "id": last[0].id,
                "value": last[1],
                "signature": signature,
            }
        )
    return SearchPage(
        items=items,
        next_cursor=next_cursor,
        explanation={
            "semantic_query": request.query,
            "structured_filter": request.filter.model_dump(mode="json")
            if request.filter
            else None,
            "ranking_strategy": "cosine_distance_then_uuid"
            if is_semantic
            else request.sort,
            "model_revision": model_revision,
            "notice": (
                "Texto livre é semântico; filtros estruturados são aplicados exatamente."
            ),
        },
    )
