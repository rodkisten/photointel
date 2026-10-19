"""Actual PostgreSQL cache single-flight, retention and stale-owner fencing."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from photointel.config import Settings
from photointel.database import SessionLocal, engine
from photointel.errors import AppError
from photointel.models import ModelRegistry, QueryEmbeddingCache
from photointel.services.query_cache import cached_text_embedding, query_cache_key
from sqlalchemy import delete, func, select, update

from gpu.pipelines.contracts import TextEmbedding

pytestmark = pytest.mark.integration


async def create_model() -> ModelRegistry:
    async with SessionLocal() as session, session.begin():
        model = ModelRegistry(
            provider=f"cache-test-{uuid4()}",
            model_name="test/siglip",
            revision="b" * 40,
            architecture="test-shape-only",
            embedding_dimension=768,
            parameters={},
            capabilities=[],
            active=False,
        )
        session.add(model)
        await session.flush()
        return model


async def cleanup(model: ModelRegistry) -> None:
    async with SessionLocal() as session, session.begin():
        await session.execute(
            delete(QueryEmbeddingCache).where(QueryEmbeddingCache.model_id == model.id)
        )
        await session.execute(delete(ModelRegistry).where(ModelRegistry.id == model.id))


def settings() -> Settings:
    return Settings(
        _env_file=None,
        app_env="test",
        inference_backend="test",
        gpu_enabled=True,
        siglip_model_id="test/siglip",
        siglip_model_revision="b" * 40,
        query_cache_wait_seconds=5,
    )


async def test_concurrent_cache_hit_does_not_call_inference_twice_or_hold_db(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = await create_model()
    calls = 0

    async def inference(_query: str, _settings: Settings) -> TextEmbedding:
        nonlocal calls
        calls += 1
        # A competing caller may briefly own its independent polling connection.
        # Transaction release is checked separately without this race.
        await asyncio.sleep(0.15)
        return TextEmbedding(
            embedding=[1.0] + [0.0] * 767, runtime_ms=1, model_revision="b" * 40
        )

    monkeypatch.setattr("photointel.services.inference.embed_text", inference)
    query = f"photo {uuid4()}"
    try:
        first, second = await asyncio.gather(
            cached_text_embedding(query, settings(), model.id),
            cached_text_embedding(query.upper(), settings(), model.id),
        )
        assert first.embedding == second.embedding
        assert calls == 1
        await cached_text_embedding(query, settings(), model.id)
        assert calls == 1
        async with SessionLocal() as session:
            row = await session.get(
                QueryEmbeddingCache, query_cache_key(query, settings())
            )
            assert row.hit_count == 2
            assert row.owner_token is None
            assert row.lease_until is None
    finally:
        await cleanup(model)


async def test_expired_owner_is_reclaimed_but_stale_results_are_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = await create_model()
    query = f"stale {uuid4()}"
    config = settings()
    key = query_cache_key(query, config)
    now = datetime.now(UTC)
    async with SessionLocal() as session, session.begin():
        session.add(
            QueryEmbeddingCache(
                cache_key=key,
                model_id=model.id,
                model_revision=config.siglip_model_revision,
                preprocessing_revision=config.query_preprocessing_revision,
                status="generating",
                owner_token=uuid4(),
                lease_until=now - timedelta(seconds=1),
                expires_at=now + timedelta(days=1),
                created_at=now,
                updated_at=now,
            )
        )
    replacement = uuid4()

    async def inference(_query: str, _settings: Settings) -> TextEmbedding:
        async with SessionLocal() as session, session.begin():
            await session.execute(
                update(QueryEmbeddingCache)
                .where(QueryEmbeddingCache.cache_key == key)
                .values(owner_token=replacement)
            )
        return TextEmbedding(
            embedding=[1.0] + [0.0] * 767, runtime_ms=1, model_revision="b" * 40
        )

    monkeypatch.setattr("photointel.services.inference.embed_text", inference)
    try:
        with pytest.raises(AppError, match="expirou"):
            await cached_text_embedding(query, config, model.id)
        async with SessionLocal() as session:
            row = await session.get(QueryEmbeddingCache, key)
            assert row.owner_token == replacement
            assert row.vector is None
    finally:
        await cleanup(model)


async def test_cache_entry_limit_and_expiry_are_bounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = await create_model()
    config = settings().model_copy(update={"query_cache_max_entries": 2})
    calls = 0

    async def inference(_query: str, _settings: Settings) -> TextEmbedding:
        nonlocal calls
        calls += 1
        return TextEmbedding(
            embedding=[1.0] + [0.0] * 767, runtime_ms=0, model_revision="b" * 40
        )

    monkeypatch.setattr("photointel.services.inference.embed_text", inference)
    prefix = str(uuid4())
    try:
        for index in range(3):
            await cached_text_embedding(f"{prefix} {index}", config, model.id)
        async with SessionLocal() as session:
            count = await session.scalar(
                select(func.count()).select_from(QueryEmbeddingCache)
            )
            assert count <= 2
        key = query_cache_key(f"{prefix} 2", config)
        async with SessionLocal() as session, session.begin():
            await session.execute(
                update(QueryEmbeddingCache)
                .where(QueryEmbeddingCache.cache_key == key)
                .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
            )
        await cached_text_embedding(f"{prefix} 2", config, model.id)
        assert calls == 4
    finally:
        await cleanup(model)


async def test_semantic_outage_preserves_exact_filters_without_fake_scores(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from photointel.models import Asset, Library
    from photointel.schemas import SearchRequest
    from photointel.services.search import execute_search

    async with SessionLocal() as session, session.begin():
        library = Library(
            source_type="fixture",
            source_identifier=str(uuid4()),
            name="Search outage fixture",
            configuration={},
        )
        session.add(library)
        await session.flush()
        asset = Asset(
            library_id=library.id,
            source_asset_key="fallback",
            filename="fixture.jpg",
            width=2000,
            height=1000,
        )
        session.add(asset)
        await session.flush()
        asset_id, library_id = asset.id, library.id

    async def unavailable(_session, _request):
        raise AppError("GPU_UNAVAILABLE", "Temporariamente indisponível", 503)

    monkeypatch.setattr("photointel.services.search.semantic_vector", unavailable)
    try:
        async with SessionLocal() as session:
            result = await execute_search(
                session,
                SearchRequest.model_validate(
                    {
                        "query": "planta dentro de casa",
                        "filter": {"op": "source", "value": str(library_id)},
                    }
                ),
            )
            assert [item.id for item in result.items] == [asset_id]
            assert result.explanation["semantic_status"] == "unavailable"
            assert result.explanation["semantic_retryable"] is True
            assert result.items[0].ranking["semantic_similarity"] is None
            assert result.items[0].ranking["exact_filters_applied"] is True

        async def incompatible(_session, _request):
            raise AppError("INFERENCE_FAILED", "Modelo incompatível", 409)

        monkeypatch.setattr("photointel.services.search.semantic_vector", incompatible)
        async with SessionLocal() as session:
            with pytest.raises(AppError, match="incompatível"):
                await execute_search(session, SearchRequest(query="planta"))
    finally:
        async with SessionLocal() as session, session.begin():
            await session.execute(delete(Asset).where(Asset.id == asset_id))
            await session.execute(delete(Library).where(Library.id == library_id))


async def test_external_text_encoder_releases_database_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = await create_model()

    async def inference(_query: str, _settings: Settings) -> TextEmbedding:
        assert engine.pool.checkedout() == 0
        await asyncio.sleep(0.05)
        assert engine.pool.checkedout() == 0
        return TextEmbedding(
            embedding=[1.0] + [0.0] * 767, runtime_ms=1, model_revision="b" * 40
        )

    monkeypatch.setattr("photointel.services.inference.embed_text", inference)
    try:
        await cached_text_embedding(f"external {uuid4()}", settings(), model.id)
    finally:
        await cleanup(model)


async def test_transaction_pool_client_configuration_executes_real_queries() -> None:
    from photointel.config import get_settings
    from photointel.db_connection import (
        database_connection_options,
        database_engine_options,
    )
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    # Real asyncpg transport with exactly the transaction-pooler client options.
    # This verifies client compatibility, not a hosted Neon/PgBouncer deployment.
    config = get_settings().model_copy(update={"database_pool_mode": "transaction"})
    url, args = database_connection_options(config)
    pooled_engine = create_async_engine(
        url, connect_args=args, **database_engine_options(config)
    )

    async def query(value: int) -> int:
        async with pooled_engine.connect() as connection:
            return await connection.scalar(text("SELECT 40 + :value"), {"value": value})

    try:
        assert await asyncio.gather(*(query(index) for index in range(3))) == [40, 41, 42]
        assert await query(2) == 42
    finally:
        await pooled_engine.dispose()
