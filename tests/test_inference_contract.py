"""Validate model protocol and spending gates without downloads or GPU execution."""

import base64
import io
from uuid import uuid4

import pytest
from PIL import Image
from pydantic import ValidationError

from gpu.models.adapters import decode_image
from gpu.pipelines.contracts import ImageResult, ModelSpec, TextEmbedding
from photointel.config import Settings
from photointel.errors import AppError
from photointel.services.inference import (
    embed_text,
    image_inference,
    test_vector as make_test_vector,
    validate_spending,
)


def configured(**changes) -> Settings:
    return Settings(
        _env_file=None, app_env="test", inference_backend="test", gpu_enabled=True,
        joytag_model_revision="a" * 40, siglip_model_revision="b" * 40,
        **changes,
    )


def test_checkpoint_requires_immutable_revisions() -> None:
    with pytest.raises(ValidationError):
        ModelSpec(joytag_revision="main", siglip_revision="b" * 40)


@pytest.mark.parametrize("vector", [[0.] * 768, [1.] * 768, [float("nan")] * 768])
def test_invalid_vectors_rejected(vector: list[float]) -> None:
    with pytest.raises(ValidationError):
        TextEmbedding(embedding=vector, model_revision="b" * 40, runtime_ms=1)


def test_embedding_dimension_validated() -> None:
    with pytest.raises(ValidationError):
        TextEmbedding(embedding=[1.], model_revision="b" * 40, runtime_ms=1)


@pytest.mark.parametrize("probability", [-.1, 1.1, float("inf"), float("nan")])
def test_invalid_probabilities_rejected(probability: float) -> None:
    with pytest.raises(ValidationError):
        ImageResult(
            asset_id=uuid4(), input_revision="1", model_revision="b" * 40,
            joytag_revision="a" * 40, embedding=make_test_vector(b"test"),
            probabilities={"sky": probability}, runtime_ms=1, joytag_runtime_ms=1,
        )


def test_corrupt_images_rejected() -> None:
    with pytest.raises(ValueError, match="corrupt"):
        decode_image(base64.b64encode(b"not an image").decode())


def test_decode_preserves_aspect_and_removes_image_metadata() -> None:
    image = Image.new("RGB", (80, 30), (40, 60, 80))
    output = io.BytesIO()
    image.save(output, format="PNG")
    decoded = decode_image(base64.b64encode(output.getvalue()).decode())
    assert decoded.size == (80, 30)
    assert decoded.mode == "RGB"


def test_disabled_inference_cannot_spend() -> None:
    with pytest.raises(AppError, match="desativada"):
        validate_spending(Settings(_env_file=None), 1)


def test_count_and_cost_limits() -> None:
    with pytest.raises(AppError, match="Limite"):
        validate_spending(configured(gpu_max_assets_per_run=2), 3)
    with pytest.raises(AppError, match="Estimativa"):
        validate_spending(configured(gpu_max_cost_per_run=0), 1)


async def test_disabled_embedding_reports_capability_error_not_missing_revision() -> None:
    with pytest.raises(AppError, match="desativada"):
        await embed_text("plantas", Settings(_env_file=None))


async def test_explicit_test_adapter_has_normalized_deterministic_embeddings() -> None:
    first = await embed_text("plantas dentro de casa", configured())
    second = await embed_text("plantas dentro de casa", configured())
    assert first == second
    assert len(first.embedding) == 768
    assert first.model_revision == "b" * 40
    assert first.runtime_ms == 0


async def test_test_adapter_rejected_if_validation_bypassed() -> None:
    unsafe = configured().model_copy(update={"app_env": "production"})
    from gpu.pipelines.contracts import ImageInput, ImageRequest
    request = ImageRequest(
        models=ModelSpec(joytag_revision="a" * 40, siglip_revision="b" * 40),
        images=[ImageInput(asset_id=uuid4(), input_revision="1", image_base64="dGVzdGluZw==")],
    )
    with pytest.raises(AppError, match="restrito"):
        await image_inference(request, unsafe)
