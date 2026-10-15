"""HTTP safety checks use an explicit in-test model object, never real credits."""

import httpx
import pytest

from gpu.pipelines.contracts import ImageRequest, ImageResponse, ModelSpec, TextEmbedding
from gpu.service import create_service

SPEC = ModelSpec(joytag_revision="a" * 40, siglip_revision="b" * 40)
TOKEN = "explicit-test-service-token-32-characters"


class InTestModels:
    def __init__(self) -> None:
        self.calls = 0

    def infer(self, request: ImageRequest) -> ImageResponse:
        self.calls += 1
        raise ValueError("corrupt private_image_payload")

    def embed_text(self, text: str) -> TextEmbedding:
        self.calls += 1
        return TextEmbedding(
            embedding=[1.0] + [0.0] * 767,
            model_revision=SPEC.siglip_revision,
            runtime_ms=1,
        )


@pytest.fixture
def models() -> InTestModels:
    return InTestModels()


async def test_service_denies_missing_bearer_before_model_execution(
    models: InTestModels,
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_service(models, SPEC, TOKEN)),
        base_url="https://private.test",
    ) as client:
        response = await client.post(
            "/embed-text",
            json={
                "models": SPEC.model_dump(),
                "text": "consulta privada",
            },
        )
        assert response.status_code == 401
        assert models.calls == 0
        assert (await client.get("/docs")).status_code == 404


async def test_service_revision_match_and_private_validation_errors(
    models: InTestModels,
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_service(models, SPEC, TOKEN)),
        base_url="https://private.test",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = await client.post(
            "/embed-text",
            json={
                "models": {**SPEC.model_dump(), "siglip_revision": "c" * 40},
                "text": "private_sensitive_query",
            },
        )
        assert response.status_code == 422
        assert "private_sensitive_query" not in response.text
        assert models.calls == 0
        response = await client.post(
            "/embed-text",
            json={
                "models": SPEC.model_dump(),
                "text": "plantas",
            },
        )
        assert response.status_code == 200
        assert len(response.json()["embedding"]) == 768
        assert models.calls == 1


async def test_service_bounds_chunked_body_without_content_length(
    models: InTestModels,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("gpu.service.MAX_REQUEST_BYTES", 40)

    async def oversized_body():
        yield b"private" * 5
        yield b"sensitive" * 5

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_service(models, SPEC, TOKEN)),
        base_url="https://private.test",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = await client.post("/embed-text", content=oversized_body())
        assert response.status_code == 413
        assert "private" not in response.text
        assert models.calls == 0
