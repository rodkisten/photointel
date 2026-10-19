"""Runtime upgrades preserve old vectors and never mix preprocessing namespaces."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from photointel.config import Settings
from photointel.database import engine
from photointel.errors import AppError
from photointel.models import Asset, Embedding, Library, ModelRegistry
from photointel.schemas import SearchRequest
from photointel.services.inference import registry
from photointel.services.search import semantic_vector
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

pytestmark = pytest.mark.integration


async def test_new_runtime_preserves_legacy_vectors_and_requires_reindex(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(
        _env_file=None,
        app_env="test",
        inference_backend="test",
        gpu_enabled=True,
        joytag_model_revision="a" * 40,
        siglip_model_revision="b" * 40,
    )

    async def current_settings(session: AsyncSession) -> Settings:
        return settings

    monkeypatch.setattr(
        "photointel.services.runtime_settings.effective_settings", current_settings
    )
    async with engine.connect() as connection:
        transaction = await connection.begin()
        async with AsyncSession(
            bind=connection, expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        ) as session:
            # Independent fixture namespace allows this test alongside existing rows.
            settings.siglip_model_id = f"namespace-test/{uuid4()}"
            library = Library(
                source_type="fixture", source_identifier=str(uuid4()), name="Namespace"
            )
            legacy = ModelRegistry(
                provider="huggingface", model_name=settings.siglip_model_id,
                revision=settings.siglip_model_revision,
                architecture="SigLIP2-base-patch16-224", embedding_dimension=768,
                preprocessing_revision="legacy-v1", parameters={},
                capabilities=["image_embedding", "text_embedding"], active=True,
            )
            session.add_all([library, legacy])
            await session.flush()
            asset = Asset(
                library_id=library.id, source_asset_key="one", filename="synthetic.png"
            )
            session.add(asset)
            await session.flush()
            embedding = Embedding(
                asset_id=asset.id, model_id=legacy.id, input_revision="1",
                vector=[1.0] + [0.0] * 767,
            )
            session.add(embedding)
            await session.flush()
            _, current_id = await registry(session, settings)
            current = await session.get(ModelRegistry, current_id)
            assert current_id != legacy.id
            assert current.preprocessing_revision == settings.query_preprocessing_revision
            assert current.parameters["preprocessing_revision"] == (
                settings.query_preprocessing_revision
            )
            await session.refresh(legacy)
            assert not legacy.active
            assert legacy.revision == current.revision == settings.siglip_model_revision
            assert await session.get(Embedding, embedding.id) is embedding
            assert float(embedding.vector[0]) == 1.0
            assert await session.scalar(
                select(func.count()).select_from(Embedding).where(
                    Embedding.asset_id == asset.id
                )
            ) == 1
            with pytest.raises(AppError) as missing:
                await semantic_vector(
                    session, SearchRequest(source_asset_id=asset.id)
                )
            assert missing.value.status_code == 404

            path = (
                Path(__file__).resolve().parents[2]
                / "infra/migrations/versions/0007_model_preprocessing_namespace.py"
            )
            spec = importlib.util.spec_from_file_location("namespace_migration", path)
            assert spec and spec.loader
            migration = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(migration)

            def refuse_unsafe_downgrade(sync: Session) -> None:
                migration.op = SimpleNamespace(get_bind=lambda: sync.connection())
                with pytest.raises(RuntimeError, match="must not be silently merged"):
                    migration.downgrade()

            await session.run_sync(refuse_unsafe_downgrade)
            assert await session.get(Embedding, embedding.id) is embedding
        await transaction.rollback()
