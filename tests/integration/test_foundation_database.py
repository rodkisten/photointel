"""Validate the migrated PostgreSQL schema, invariants and actual indexed types."""

from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from photointel.database import Base, engine
from photointel.models import Asset, Library, ModelRegistry
from photointel.services.catalog import refresh_search_document
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration


@pytest.fixture
async def foundation_database() -> AsyncIterator[AsyncSession]:
    async with engine.connect() as connection:
        transaction = await connection.begin()
        async with AsyncSession(
            bind=connection,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        ) as session:
            yield session
        await transaction.rollback()


async def test_all_tables_extensions_and_vector_indexes_are_migrated(
    foundation_database: AsyncSession,
) -> None:
    tables = set(
        (
            await foundation_database.scalars(
                text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
            )
        ).all()
    )
    assert set(Base.metadata.tables).issubset(tables)
    extensions = set(
        (
            await foundation_database.scalars(text("SELECT extname FROM pg_extension"))
        ).all()
    )
    assert {"vector", "pg_trgm"}.issubset(extensions)
    dimension = await foundation_database.scalar(
        text("""
        SELECT format_type(atttypid, atttypmod) FROM pg_attribute
        WHERE attrelid = 'embeddings'::regclass AND attname = 'vector'
    """)
    )
    assert dimension == "vector(768)"
    indexes = dict(
        (
            await foundation_database.execute(
                text(
                    "SELECT indexname, indexdef FROM pg_indexes "
                    "WHERE schemaname = 'public'"
                )
            )
        ).all()
    )
    assert "USING hnsw" in indexes["ix_embeddings_cosine_hnsw"]
    assert "vector_cosine_ops" in indexes["ix_embeddings_cosine_hnsw"]
    assert "USING gin" in indexes["ix_assets_search_document"]
    assert "gin_trgm_ops" in indexes["ix_tags_name_trgm"]
    assert "local_identifier" in indexes["ix_photokit_snapshot_device_local"]
    assert "photokit" in indexes["ix_photokit_snapshot_device_local"]
    assert "verification_status" in indexes["ix_device_mappings_asset_verification"]
    # ORM metadata must retain migration-owned indexes during future autogeneration.
    expected_indexes = {
        index.name for table in Base.metadata.tables.values() for index in table.indexes
    }
    assert expected_indexes.issubset(indexes)


async def test_asset_identity_is_unique_per_source_not_per_filename(
    foundation_database: AsyncSession,
) -> None:
    library = Library(
        name="Independent identity test",
        source_type="fixture",
        source_identifier=f"schema-{uuid4()}",
    )
    foundation_database.add(library)
    await foundation_database.flush()
    first = Asset(library_id=library.id, source_asset_key="remote-1", filename="same.jpg")
    second = Asset(
        library_id=library.id, source_asset_key="remote-2", filename="same.jpg"
    )
    foundation_database.add_all([first, second])
    await foundation_database.flush()
    assert first.id != second.id
    with pytest.raises(IntegrityError):
        async with foundation_database.begin_nested():
            foundation_database.add(
                Asset(
                    library_id=library.id,
                    source_asset_key="remote-1",
                    filename="different.jpg",
                )
            )
            await foundation_database.flush()
    assert await foundation_database.get(Asset, first.id) is not None


async def test_filename_search_document_is_updated_by_database_trigger(
    foundation_database: AsyncSession,
) -> None:
    library = Library(
        name="Full-text test",
        source_type="fixture",
        source_identifier=f"fts-{uuid4()}",
    )
    foundation_database.add(library)
    await foundation_database.flush()
    asset = Asset(
        library_id=library.id,
        source_asset_key="fts-photo",
        filename="tropical beach.jpg",
    )
    foundation_database.add(asset)
    await foundation_database.flush()
    result = await foundation_database.scalar(
        select(Asset.id).where(
            Asset.id == asset.id,
            Asset.search_document.op("@@")(
                text("websearch_to_tsquery('simple', 'tropical')")
            ),
        )
    )
    assert result == asset.id
    asset.filename = "indoor garden.jpg"
    await foundation_database.flush()
    result = await foundation_database.scalar(
        select(Asset.id).where(
            Asset.id == asset.id,
            Asset.search_document.op("@@")(
                text("websearch_to_tsquery('simple', 'garden')")
            ),
        )
    )
    assert result == asset.id
    old_term = await foundation_database.scalar(
        select(Asset.id).where(
            Asset.id == asset.id,
            Asset.search_document.op("@@")(
                text("websearch_to_tsquery('simple', 'tropical')")
            ),
        )
    )
    assert old_term is None


@pytest.mark.parametrize(
    "filename,term",
    [
        ("garden.jpg", "garden"),
        ("summer_beach-2020.jpeg", "beach"),
        ("synthetic-landscape-beach-176000.jpg", "landscape"),
        ("verão_flores.heic", "flores"),
    ],
)
async def test_filename_search_indexes_words_around_punctuation(
    foundation_database: AsyncSession,
    filename: str,
    term: str,
) -> None:
    library = Library(
        name="Filename tokenization test",
        source_type="fixture",
        source_identifier=f"filename-tokens-{uuid4()}",
    )
    foundation_database.add(library)
    await foundation_database.flush()
    asset = Asset(library_id=library.id, source_asset_key="tokens", filename=filename)
    foundation_database.add(asset)
    await foundation_database.flush()
    query = (
        select(Asset.id)
        .where(
            Asset.id == asset.id,
            Asset.search_document.op("@@")(
                text("websearch_to_tsquery('simple', :filename_term)")
            ),
        )
        .params(filename_term=term)
    )
    assert await foundation_database.scalar(query) == asset.id
    # Tag edits and reindexing rebuild documents through a separate application
    # path; its tokenization must match the database trigger.
    await refresh_search_document(foundation_database, [asset.id])
    assert await foundation_database.scalar(query) == asset.id


async def test_only_one_active_revision_per_model_and_dimensions_are_enforced(
    foundation_database: AsyncSession,
) -> None:
    name = f"schema-model-{uuid4()}"
    first = ModelRegistry(
        provider="local-test",
        model_name=name,
        revision="a" * 40,
        architecture="siglip2",
        embedding_dimension=768,
        active=True,
    )
    foundation_database.add(first)
    await foundation_database.flush()
    with pytest.raises(IntegrityError):
        async with foundation_database.begin_nested():
            foundation_database.add(
                ModelRegistry(
                    provider="local-test",
                    model_name=name,
                    revision="b" * 40,
                    architecture="siglip2",
                    embedding_dimension=768,
                    active=True,
                )
            )
            await foundation_database.flush()
    with pytest.raises(IntegrityError):
        async with foundation_database.begin_nested():
            foundation_database.add(
                ModelRegistry(
                    provider="local-test",
                    model_name=f"wrong-dim-{uuid4()}",
                    revision="c" * 40,
                    architecture="siglip2",
                    embedding_dimension=1024,
                    active=False,
                )
            )
            await foundation_database.flush()
