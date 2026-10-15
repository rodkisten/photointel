"""Resolve public checkpoint evidence without downloading weights or starting GPU."""

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from gpu.pipelines.contracts import EMBEDDING_DIMENSION, validate_revision

CONFIG_DEFAULTS_SOURCE = (
    "https://github.com/huggingface/transformers/blob/v4.57.6/"
    "src/transformers/models/siglip/configuration_siglip.py"
)
CONFIG_DEFAULTS_BLOB = "0c182014fa272bb53b9e597894daa104a864a2c9"


def siglip_dimensions(config: dict[str, Any]) -> tuple[int, int]:
    """Resolve the sparse checkpoint using verified Transformers 4.57.6 defaults.

    The selected SigLIP 2 checkpoint serializes only values differing from SiglipConfig.
    RealModels also checks the fully instantiated model config before any inference.
    """
    if config.get("model_type") != "siglip":
        raise ValueError("Unsupported checkpoint configuration architecture")
    vision = config.get("vision_config", {})
    text = config.get("text_config", {})
    vision_dimension = int(vision.get("hidden_size", 768))
    text_hidden = int(text.get("hidden_size", 768))
    text_dimension = int(text.get("projection_size") or text_hidden)
    return vision_dimension, text_dimension


def inspect_model(client: httpx.Client, model_id: str) -> dict[str, Any]:
    response = client.get(f"https://huggingface.co/api/models/{model_id}")
    response.raise_for_status()
    metadata = response.json()
    revision = validate_revision(metadata["sha"])
    base = f"https://huggingface.co/{model_id}/resolve/{revision}/"
    response = client.get(base + "config.json")
    response.raise_for_status()
    config = response.json()
    result = {
        "model_id": model_id, "revision": revision,
        "license": metadata.get("cardData", {}).get("license", "not_declared"),
        "config": config,
    }
    if model_id == "fancyfeast/joytag":
        vocabulary = client.get(base + "top_tags.txt")
        vocabulary.raise_for_status()
        tags = [line.strip() for line in vocabulary.text.splitlines() if line.strip()]
        if len(tags) != config["n_tags"]:
            raise ValueError("JoyTag vocabulary and classifier dimensions do not match")
        result["vocabulary_size"] = len(tags)
        result["vocabulary_sha256"] = hashlib.sha256(vocabulary.content).hexdigest()
        result["image_size"] = config["image_size"]
    else:
        vision_dimension, text_dimension = siglip_dimensions(config)
        if vision_dimension != EMBEDDING_DIMENSION:
            raise ValueError("Image checkpoint requires a database vector migration")
        if text_dimension != EMBEDDING_DIMENSION:
            raise ValueError("Text checkpoint requires a database vector migration")
        result["embedding_dimension"] = EMBEDDING_DIMENSION
        result["sparse_config_defaults"] = {
            "source": CONFIG_DEFAULTS_SOURCE, "source_git_blob": CONFIG_DEFAULTS_BLOB,
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verificar metadados públicos; sem pesos/GPU",
    )
    parser.add_argument(
        "--output", type=Path, default=Path("reports/model-evidence.json"),
    )
    arguments = parser.parse_args()
    with httpx.Client(timeout=30, follow_redirects=True) as client:
        report = {
            "verified_at": datetime.now(UTC).isoformat(),
            "models": [inspect_model(client, name) for name in [
                "fancyfeast/joytag", "google/siglip2-base-patch16-224",
            ]],
        }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"output": str(arguments.output), "weights_downloaded": False}))


if __name__ == "__main__":
    main()
