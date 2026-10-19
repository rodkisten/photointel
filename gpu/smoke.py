"""Explicit real-model smoke test; never executed by installation or normal tests."""

import argparse
import asyncio
import json
import math
from uuid import UUID


async def smoke(asset_id: UUID) -> None:
    from photointel.config import get_settings
    from photointel.database import SessionLocal
    from photointel.models import Asset, Embedding, InferenceRun
    from photointel.services.inference import embed_text, infer_assets, registry
    from sqlalchemy import select

    settings = get_settings()
    if not settings.gpu_enabled or settings.inference_backend == "test":
        raise SystemExit("Configure real inference and explicitly set GPU_ENABLED=true")
    async with SessionLocal() as session:
        result = await infer_assets(session, [asset_id], settings)
        await session.commit()
        asset = await session.get(Asset, asset_id)
        assert asset is not None
        joytag_id, siglip_id = await registry(session, settings)
        runs = (
            await session.scalars(
                select(InferenceRun).where(
                    InferenceRun.asset_id == asset_id,
                    InferenceRun.status == "completed",
                    InferenceRun.model_id.in_([joytag_id, siglip_id]),
                    InferenceRun.input_revision == asset.representation_revision,
                )
            )
        ).all()
        embedding = await session.scalar(
            select(Embedding)
            .where(
                Embedding.asset_id == asset_id,
                Embedding.model_id == siglip_id,
                Embedding.input_revision == asset.representation_revision,
            )
            .limit(1)
        )
        assert {run.model_id for run in runs} == {joytag_id, siglip_id}
        assert embedding is not None
        joytag_run = next(run for run in runs if run.model_id == joytag_id)
        probabilities = joytag_run.raw_predictions.get("probabilities")
        assert isinstance(probabilities, dict) and probabilities
        assert all(
            math.isfinite(value) and 0 <= value <= 1 for value in probabilities.values()
        )
        assert len(embedding.vector) == settings.siglip_embedding_dimension
        norm = math.sqrt(sum(float(value) ** 2 for value in embedding.vector))
        assert math.isfinite(norm) and abs(norm - 1) <= 0.002
        # No transaction or model-registry lock may survive remote text inference.
        vector = [float(value) for value in embedding.vector]
        await session.commit()
        text_result = await embed_text("Fotografia de paisagem", settings)
        assert text_result.model_revision == settings.siglip_model_revision
        similarity = sum(
            float(a) * b
            for a, b in zip(
                vector,
                text_result.embedding,
                strict=True,
            )
        )
        assert -1.001 <= similarity <= 1.001
        report = {
            "real_inference": True,
            "inference_backend": settings.inference_backend,
            "image_inference_performed": result["completed"] > 0,
            "persisted": True,
            "dimension": len(embedding.vector),
            "joytag_probabilities": len(probabilities),
            "metrics": result,
        }
    # Report persistence only after the transaction has committed successfully.
    print(json.dumps(report))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Teste real explícito; pode consumir créditos",
    )
    parser.add_argument("--asset-id", type=UUID, required=True)
    arguments = parser.parse_args()
    asyncio.run(smoke(arguments.asset_id))


if __name__ == "__main__":
    main()
