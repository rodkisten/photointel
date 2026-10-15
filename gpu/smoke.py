"""Explicit real-model smoke test; never executed by installation or normal tests."""

import argparse
import asyncio
import json
from uuid import UUID


async def smoke(asset_id: UUID) -> None:
    from photointel.config import get_settings
    from photointel.database import SessionLocal
    from photointel.models import Embedding, InferenceRun
    from photointel.services.inference import embed_text, infer_assets
    from sqlalchemy import select

    settings = get_settings()
    if not settings.gpu_enabled or settings.inference_backend == "test":
        raise SystemExit("Configure real inference and explicitly set GPU_ENABLED=true")
    async with SessionLocal() as session, session.begin():
        result = await infer_assets(session, [asset_id], settings)
        runs = (
            await session.scalars(
                select(InferenceRun).where(
                    InferenceRun.asset_id == asset_id,
                    InferenceRun.status == "completed",
                )
            )
        ).all()
        embedding = await session.scalar(
            select(Embedding)
            .where(
                Embedding.asset_id == asset_id,
            )
            .limit(1)
        )
        assert len(runs) >= 2 and embedding is not None
        assert len(embedding.vector) == settings.siglip_embedding_dimension
        text_result = await embed_text("Fotografia de paisagem", settings)
        similarity = sum(
            float(a) * b
            for a, b in zip(
                embedding.vector,
                text_result.embedding,
                strict=True,
            )
        )
        assert -1.001 <= similarity <= 1.001
        print(
            json.dumps(
                {
                    "real_inference": True,
                    "persisted": True,
                    "dimension": len(embedding.vector),
                    "metrics": result,
                }
            )
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Teste real explícito; pode consumir créditos",
    )
    parser.add_argument("--asset-id", type=UUID, required=True)
    arguments = parser.parse_args()
    asyncio.run(smoke(arguments.asset_id))


if __name__ == "__main__":
    main()
