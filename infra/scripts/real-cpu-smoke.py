"""Operator-only real CPU model validation; never allocates a provider GPU."""

import argparse
import asyncio
import importlib.metadata
import json
import math
import re
import time
import tomllib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
EXCLUDED_PACKAGES = {"torch", "torchvision", "triton", "pytorch-triton"}


def cpu_requirements(requirements: str) -> str:
    """Keep frozen dependency pins while omitting CUDA and replaced CPU wheels."""
    retained = []
    for line in requirements.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        match = re.match(r"^([a-zA-Z0-9_.-]+)(?:\[.*?\])?==", line)
        if not match:
            raise ValueError(f"Expected one frozen requirement per line: {line[:100]}")
        package = match[1].lower().replace("_", "-")
        if package in EXCLUDED_PACKAGES or package.startswith(("cuda-", "nvidia-")):
            continue
        retained.append(line)
    if not retained:
        raise ValueError("Empty CPU dependency list")
    return "\n".join(retained) + "\n"


def prepare_dependencies(export: Path, output: Path) -> None:
    """Derive exact CPU wheel versions from the committed lock, without resolving."""
    lock = tomllib.loads((ROOT / "uv.lock").read_text())
    versions = {
        name: next(
            package["version"] for package in lock["package"] if package["name"] == name
        )
        for name in ("torch", "torchvision", "transformers")
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "cpu-dependencies.requirements.txt").write_text(
        cpu_requirements(export.read_text())
    )
    (output / "cpu-wheels.requirements.txt").write_text(
        "".join(f"{name}=={versions[name]}+cpu\n" for name in ("torch", "torchvision"))
    )
    (output / "locked-versions.json").write_text(json.dumps(versions, indent=2) + "\n")


def cpu_runtime() -> dict[str, str]:
    import torch

    versions = json.loads((ROOT / "reports/real-cpu/locked-versions.json").read_text())
    installed = {
        name: importlib.metadata.version(name)
        for name in ("torch", "torchvision", "transformers")
    }
    for name, locked in versions.items():
        if installed[name].split("+", 1)[0] != locked:
            raise RuntimeError(f"Installed {name} differs from uv.lock")
    if not all(installed[name].endswith("+cpu") for name in ("torch", "torchvision")):
        raise RuntimeError("The manual CPU workflow requires official +cpu wheels")
    if torch.version.cuda is not None or torch.cuda.is_available():
        raise RuntimeError("CPU-only validation refuses a CUDA-enabled Torch build")
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    return installed


async def validate_models(output: Path) -> None:
    from photointel.config import get_settings
    from photointel.database import SessionLocal, engine
    from photointel.models import Asset, Embedding, InferenceRun, Library, ModelRegistry
    from photointel.services.inference import embed_text, infer_assets
    from sqlalchemy import func, select

    settings = get_settings()
    if (
        settings.app_env != "test"
        or settings.inference_backend != "cpu"
        or not settings.gpu_enabled
        or settings.storage_backend != "local"
        or settings.modal_endpoint
    ):
        raise RuntimeError(
            "Requires APP_ENV=test, INFERENCE_BACKEND=cpu, GPU_ENABLED=true, "
            "STORAGE_BACKEND=local and no Modal endpoint"
        )
    pins = json.loads((ROOT / "packages/configuration/model-pins.json").read_text())
    if (
        settings.joytag_model_revision != pins["joytag"]["revision"]
        or settings.siglip_model_revision != pins["siglip2"]["revision"]
    ):
        raise RuntimeError("Smoke revisions must match the committed model pins")
    installed = cpu_runtime()
    started = time.monotonic()
    async with SessionLocal() as session:
        assets = (
            await session.scalars(
                select(Asset)
                .join(Library)
                .where(Library.source_type == "fixture", Asset.media_type == "image")
                .limit(2)
            )
        ).all()
        if len(assets) != 1:
            raise RuntimeError("Use an isolated database containing one fixture image")
        asset_id = assets[0].id
        input_revision = assets[0].representation_revision
        existing = await session.scalar(select(func.count()).select_from(InferenceRun))
        if existing:
            raise RuntimeError("First-run proof requires no existing inference records")

    async with SessionLocal() as session, session.begin():
        metrics = await infer_assets(session, [asset_id], settings)
        if metrics["completed"] != 1 or metrics["skipped"] != 0:
            raise RuntimeError("Expected newly executed inference for one image")

    # Independent session proves a real commit, rather than only ORM pending state.
    async with SessionLocal() as session:
        runs = (
            await session.execute(
                select(InferenceRun, ModelRegistry)
                .join(ModelRegistry, InferenceRun.model_id == ModelRegistry.id)
                .where(
                    InferenceRun.asset_id == asset_id,
                    InferenceRun.input_revision == input_revision,
                    InferenceRun.status == "completed",
                )
            )
        ).all()
        joytag = next(
            (
                run
                for run, model in runs
                if model.revision == settings.joytag_model_revision
            ),
            None,
        )
        siglip = next(
            (
                run
                for run, model in runs
                if model.revision == settings.siglip_model_revision
            ),
            None,
        )
        if joytag is None or siglip is None:
            raise RuntimeError("Both real inference runs must be committed")
        probabilities = joytag.raw_predictions.get("probabilities", {})
        if len(probabilities) != pins["joytag"]["vocabulary_size"] or not all(
            math.isfinite(value) and 0 <= value <= 1 for value in probabilities.values()
        ):
            raise RuntimeError("Invalid JoyTag vocabulary size or probabilities")
        embedding = await session.scalar(
            select(Embedding)
            .join(ModelRegistry, Embedding.model_id == ModelRegistry.id)
            .where(
                Embedding.asset_id == asset_id,
                Embedding.input_revision == input_revision,
                ModelRegistry.revision == settings.siglip_model_revision,
            )
        )
        if embedding is None:
            raise RuntimeError("Image embedding was not committed")
        vector = [float(value) for value in embedding.vector]
        if len(vector) != 768 or not all(math.isfinite(value) for value in vector):
            raise RuntimeError("Expected 768 finite persisted image dimensions")
        norm = math.sqrt(sum(value**2 for value in vector))
        if abs(norm - 1) > 0.002:
            raise RuntimeError("Image embedding must be normalized")
        similarities = {}
        for query in ("Paisagem com montanhas", "Fotografia de uma planta"):
            text_result = await embed_text(query, settings)
            if text_result.model_revision != settings.siglip_model_revision:
                raise RuntimeError("Image and text checkpoint revisions differ")
            similarity = sum(
                left * right
                for left, right in zip(vector, text_result.embedding, strict=True)
            )
            if not math.isfinite(similarity) or not -1.001 <= similarity <= 1.001:
                raise RuntimeError("Invalid text/image cosine similarity")
            similarities[query] = similarity
    report: dict[str, Any] = {
        "real_inference": True,
        "device": "cpu",
        "provider_gpu_allocated": False,
        "fixture_assets": 1,
        "database_persistence_verified_in_new_session": True,
        "joytag_revision": settings.joytag_model_revision,
        "joytag_probabilities": len(probabilities),
        "siglip_revision": settings.siglip_model_revision,
        "embedding_dimension": len(vector),
        "image_embedding_norm": norm,
        "text_image_cosine_similarities": similarities,
        "installed_versions": installed,
        "wall_seconds": time.monotonic() - started,
        "inference_metrics": metrics,
        "limitations": [
            "CPU result does not validate Modal deployment, CUDA or provider billing",
            "One synthetic image is not an accuracy or multilingual retrieval benchmark",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(report, ensure_ascii=False))
    await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "run"])
    parser.add_argument("--export", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "reports/real-cpu")
    arguments = parser.parse_args()
    if arguments.command == "prepare":
        if arguments.export is None:
            parser.error("prepare requires --export")
        prepare_dependencies(arguments.export, arguments.output)
    else:
        asyncio.run(validate_models(arguments.output / "result.json"))


if __name__ == "__main__":
    main()
