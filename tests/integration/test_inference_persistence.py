"""Real PostgreSQL persistence with explicit APP_ENV=test predictions, never GPU."""

from uuid import uuid4

import pytest
from photointel.config import Settings
from photointel.database import engine
from photointel.errors import AppError
from photointel.models import Asset, AssetTag, Embedding, InferenceRun, Library, Tag
from photointel.schemas import SearchRequest
from photointel.services.inference import (
    persist_result,
    registry,
)
from photointel.services.inference import (
    test_vector as make_test_data,
)
from photointel.services.search import semantic_vector
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gpu.pipelines.contracts import ImageResult

pytestmark = pytest.mark.integration


async def test_inference_persists_all_raw_scores_and_never_overwrites_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with engine.connect() as connection:
        transaction = await connection.begin()
        async with AsyncSession(
            bind=connection,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        ) as session:
            settings = Settings(
                _env_file=None,
                app_env="test",
                inference_backend="test",
                gpu_enabled=True,
                joytag_model_revision="a" * 40,
                siglip_model_revision="b" * 40,
            )
            library = Library(
                source_type="fixture", source_identifier=str(uuid4()), name="AI test"
            )
            session.add(library)
            await session.flush()
            asset = Asset(
                library_id=library.id,
                source_asset_key="inference",
                filename="synthetic.png",
                representation_revision="r2",
            )
            session.add(asset)
            await session.flush()
            joytag_id, siglip_id = await registry(session, settings)
            result = ImageResult(
                asset_id=asset.id,
                input_revision="r2",
                embedding=make_test_data(b"test"),
                joytag_revision="a" * 40,
                model_revision="b" * 40,
                probabilities={"beach": 0.9, "sky": 0.01},
                joytag_runtime_ms=4,
                runtime_ms=2,
            )
            await persist_result(
                session, asset, result, joytag_id, siglip_id, settings, {}
            )
            tag = await session.scalar(select(Tag).where(Tag.canonical_key == "beach"))
            assert tag is not None
            session.add(
                AssetTag(
                    asset_id=asset.id,
                    tag_id=tag.id,
                    origin="user",
                    user_status="rejected",
                    review_status="reviewed",
                    model_version="",
                )
            )
            await session.flush()
            await persist_result(
                session, asset, result, joytag_id, siglip_id, settings, {}
            )
            assert (
                await session.scalar(
                    select(func.count())
                    .select_from(Embedding)
                    .where(
                        Embedding.asset_id == asset.id,
                    )
                )
                == 1
            )
            assert (
                await session.scalar(
                    select(func.count())
                    .select_from(InferenceRun)
                    .where(
                        InferenceRun.asset_id == asset.id,
                    )
                )
                == 2
            )
            run = await session.scalar(
                select(InferenceRun).where(
                    InferenceRun.asset_id == asset.id,
                    InferenceRun.model_id == joytag_id,
                )
            )
            assert run.raw_predictions["probabilities"]["sky"] == 0.01
            decisions = (
                await session.scalars(
                    select(AssetTag).where(
                        AssetTag.asset_id == asset.id,
                    )
                )
            ).all()
            assert len(decisions) == 2
            assert any(
                row.origin == "user" and row.user_status == "rejected"
                for row in decisions
            )
            incompatible = result.model_copy(update={"input_revision": "old"})
            with pytest.raises(AppError, match="revisão"):
                await persist_result(
                    session,
                    asset,
                    incompatible,
                    joytag_id,
                    siglip_id,
                    settings,
                    {},
                )

            async def current_settings(_session: AsyncSession) -> Settings:
                return settings

            monkeypatch.setattr(
                "photointel.services.runtime_settings.effective_settings",
                current_settings,
            )
            vector, model = await semantic_vector(
                session,
                SearchRequest(source_asset_id=asset.id),
            )
            assert model.id == siglip_id
            assert len(vector) == 768
            # A representation update invalidates the source embedding, even if
            # historical vectors remain retained for audit/reindex operations.
            asset.representation_revision = "r3"
            await session.flush()
            with pytest.raises(AppError, match="compatível"):
                await semantic_vector(session, SearchRequest(source_asset_id=asset.id))
        await transaction.rollback()
