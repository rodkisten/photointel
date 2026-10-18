"""Revision-scoped text embeddings with fenced, durable single-flight claims.

Only a normalized query hash is retained. Each database transaction ends before
waiting or contacting inference; a crashed owner loses its bounded lease.
"""

import asyncio
import hashlib
import json
import time
import unicodedata
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import and_, delete, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert

from gpu.pipelines.contracts import TextEmbedding
from photointel.config import Settings
from photointel.database import SessionLocal
from photointel.errors import AppError, ErrorCode
from photointel.models import QueryEmbeddingCache


def normalize_query(value: str) -> str:
    normalized = " ".join(unicodedata.normalize("NFKC", value).split()).casefold()
    if not normalized or len(normalized) > 2000:
        raise AppError(ErrorCode.INVALID_REQUEST, "Consulta semântica inválida", 422)
    return normalized


def query_cache_key(query: str, settings: Settings) -> str:
    payload = [
        settings.siglip_model_id,
        settings.siglip_model_revision,
        settings.query_preprocessing_revision,
        normalize_query(query),
    ]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


async def prune_query_cache(settings: Settings) -> int:
    """Bound retention without holding a lock during any external operation."""
    now = datetime.now(UTC)
    async with SessionLocal() as session, session.begin():
        # Transaction-scoped lock is compatible with PgBouncer transaction mode;
        # it serializes pruning only, and is released by this short transaction.
        await session.execute(text("SELECT pg_advisory_xact_lock(719281052)"))
        expired = await session.scalars(
            delete(QueryEmbeddingCache)
            .where(
                QueryEmbeddingCache.expires_at < now,
                or_(
                    QueryEmbeddingCache.lease_until.is_(None),
                    QueryEmbeddingCache.lease_until < now,
                ),
            )
            .returning(QueryEmbeddingCache.cache_key)
        )
        excess = (
            select(QueryEmbeddingCache.cache_key)
            .where(QueryEmbeddingCache.status == "ready")
            .order_by(QueryEmbeddingCache.updated_at.desc())
            .offset(settings.query_cache_max_entries)
        )
        trimmed = await session.scalars(
            delete(QueryEmbeddingCache)
            .where(QueryEmbeddingCache.cache_key.in_(excess))
            .returning(QueryEmbeddingCache.cache_key)
        )
        return len(expired.all()) + len(trimmed.all())


async def cached_text_embedding(
    query: str,
    settings: Settings,
    model_id: UUID,
) -> TextEmbedding:
    from photointel.services.inference import embed_text

    normalized = normalize_query(query)
    if not settings.query_cache_enabled:
        return await embed_text(normalized, settings)
    key = query_cache_key(normalized, settings)
    owner = uuid4()
    deadline = time.monotonic() + settings.query_cache_wait_seconds
    claimed = False
    while not claimed:
        now = datetime.now(UTC)
        async with SessionLocal() as session, session.begin():
            await session.execute(text("SELECT pg_advisory_xact_lock(719281052)"))
            row = await session.get(QueryEmbeddingCache, key)
            if (
                row
                and row.status == "ready"
                and row.expires_at > now
                and row.vector is not None
            ):
                result = TextEmbedding(
                    embedding=[float(value) for value in row.vector],
                    runtime_ms=0,
                    model_revision=row.model_revision,
                )
                await session.execute(
                    update(QueryEmbeddingCache)
                    .where(QueryEmbeddingCache.cache_key == key)
                    .values(hit_count=QueryEmbeddingCache.hit_count + 1)
                )
                return result
            # Bound even concurrent cache misses. This transaction lock never
            # crosses an inference call or a polling sleep.
            if row is None:
                count = await session.scalar(
                    select(func.count()).select_from(QueryEmbeddingCache)
                )
                if int(count or 0) >= settings.query_cache_max_entries:
                    oldest = (
                        select(QueryEmbeddingCache.cache_key)
                        .where(QueryEmbeddingCache.status == "ready")
                        .order_by(QueryEmbeddingCache.updated_at.asc())
                        .limit(1)
                    )
                    removed = await session.scalar(
                        delete(QueryEmbeddingCache)
                        .where(QueryEmbeddingCache.cache_key.in_(oldest))
                        .returning(QueryEmbeddingCache.cache_key)
                    )
                    if removed is None:
                        raise AppError(
                            ErrorCode.GPU_UNAVAILABLE,
                            "Cache de consultas ocupado; tente novamente",
                            503,
                        )
            statement = insert(QueryEmbeddingCache).values(
                cache_key=key,
                model_id=model_id,
                model_revision=settings.siglip_model_revision,
                preprocessing_revision=settings.query_preprocessing_revision,
                status="generating",
                owner_token=owner,
                lease_until=now + timedelta(seconds=settings.query_cache_lease_seconds),
                expires_at=now + timedelta(seconds=settings.query_cache_ttl_seconds),
                created_at=now,
                updated_at=now,
                hit_count=0,
            )
            claim_statement = statement.on_conflict_do_update(
                index_elements=["cache_key"],
                set_={
                    "owner_token": owner,
                    "lease_until": statement.excluded.lease_until,
                    "status": "generating",
                    "vector": None,
                    "updated_at": now,
                    "expires_at": statement.excluded.expires_at,
                },
                where=and_(
                    or_(
                        QueryEmbeddingCache.status != "ready",
                        QueryEmbeddingCache.expires_at <= now,
                    ),
                    or_(
                        QueryEmbeddingCache.lease_until < now,
                        QueryEmbeddingCache.lease_until.is_(None),
                    ),
                ),
            ).returning(QueryEmbeddingCache.cache_key)
            claimed = (await session.scalar(claim_statement)) is not None
        if not claimed:
            if time.monotonic() >= deadline:
                raise AppError(
                    ErrorCode.GPU_UNAVAILABLE,
                    "A mesma consulta está sendo preparada; tente novamente",
                    503,
                )
            await asyncio.sleep(0.1)

    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(max(1, settings.query_cache_lease_seconds / 3))
            now = datetime.now(UTC)
            async with SessionLocal() as session, session.begin():
                await session.execute(
                    update(QueryEmbeddingCache)
                    .where(
                        QueryEmbeddingCache.cache_key == key,
                        QueryEmbeddingCache.owner_token == owner,
                        QueryEmbeddingCache.lease_until > now,
                    )
                    .values(
                        lease_until=now
                        + timedelta(seconds=settings.query_cache_lease_seconds)
                    )
                )

    # No database connection/transaction survives into the remote call.
    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        result = await embed_text(normalized, settings)
        if result.model_revision != settings.siglip_model_revision:
            raise AppError(ErrorCode.INFERENCE_FAILED, "Modelo incompatível", 409)
        now = datetime.now(UTC)
        async with SessionLocal() as session, session.begin():
            updated = await session.scalar(
                update(QueryEmbeddingCache)
                .where(
                    QueryEmbeddingCache.cache_key == key,
                    QueryEmbeddingCache.owner_token == owner,
                    QueryEmbeddingCache.lease_until > now,
                )
                .values(
                    vector=result.embedding,
                    status="ready",
                    owner_token=None,
                    lease_until=None,
                    updated_at=now,
                    expires_at=now + timedelta(seconds=settings.query_cache_ttl_seconds),
                )
                .returning(QueryEmbeddingCache.cache_key)
            )
            if updated is None:
                raise AppError(
                    ErrorCode.GPU_UNAVAILABLE,
                    "A preparação da consulta expirou; tente novamente",
                    503,
                )
        await prune_query_cache(settings)
        return result
    except BaseException:
        async with SessionLocal() as session, session.begin():
            await session.execute(
                delete(QueryEmbeddingCache).where(
                    QueryEmbeddingCache.cache_key == key,
                    QueryEmbeddingCache.owner_token == owner,
                )
            )
        raise
    finally:
        heartbeat_task.cancel()
        with suppress(asyncio.CancelledError):
            await heartbeat_task
