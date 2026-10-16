"""Bounded inference wire protocol shared by API and isolated GPU service."""

import math
import re
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_REQUEST_BYTES = 40 * 1024 * 1024
EMBEDDING_DIMENSION = 768


def validate_revision(value: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ValueError("Model revision must be an immutable 40-character commit SHA")
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ModelSpec(StrictModel):
    joytag_model_id: str = "fancyfeast/joytag"
    joytag_revision: str
    siglip_model_id: str = "google/siglip2-base-patch16-224"
    siglip_revision: str

    _revision = field_validator("joytag_revision", "siglip_revision")(validate_revision)

    @field_validator("joytag_model_id")
    @classmethod
    def approved_joytag(cls, value: str) -> str:
        if value != "fancyfeast/joytag":
            raise ValueError("Model architecture is not supported by this release")
        return value

    @field_validator("siglip_model_id")
    @classmethod
    def approved_siglip(cls, value: str) -> str:
        if value != "google/siglip2-base-patch16-224":
            raise ValueError("Model architecture is not supported by this release")
        return value


class ImageInput(StrictModel):
    asset_id: UUID
    input_revision: str = Field(min_length=1, max_length=128)
    image_base64: str = Field(min_length=8, max_length=7 * 1024 * 1024)


class ImageRequest(StrictModel):
    models: ModelSpec
    images: list[ImageInput] = Field(min_length=1, max_length=32)
    batch_size: int = Field(default=8, ge=1, le=32)


class TextRequest(StrictModel):
    models: ModelSpec
    text: str = Field(min_length=1, max_length=2000)


class TextEmbedding(StrictModel):
    embedding: list[float] = Field(
        min_length=EMBEDDING_DIMENSION,
        max_length=EMBEDDING_DIMENSION,
    )
    model_revision: str
    runtime_ms: float = Field(ge=0)

    @field_validator("embedding")
    @classmethod
    def normalized_embedding(cls, value: list[float]) -> list[float]:
        norm = math.sqrt(sum(x * x for x in value))
        if not math.isfinite(norm) or abs(norm - 1) > 0.002:
            raise ValueError("Expected finite, normalized embedding")
        return value


class ImageResult(TextEmbedding):
    asset_id: UUID
    input_revision: str = Field(min_length=1, max_length=128)
    joytag_revision: str
    probabilities: dict[str, float] = Field(max_length=20000)
    joytag_runtime_ms: float = Field(ge=0)

    @field_validator("probabilities")
    @classmethod
    def probability_range(cls, value: dict[str, float]) -> dict[str, float]:
        if not value or any(
            not key or len(key) > 255 or not math.isfinite(p) or not 0 <= p <= 1
            for key, p in value.items()
        ):
            raise ValueError("Invalid JoyTag probability vocabulary")
        return value


class ImageResponse(StrictModel):
    results: list[ImageResult] = Field(min_length=1, max_length=32)
    total_runtime_ms: float = Field(ge=0)
