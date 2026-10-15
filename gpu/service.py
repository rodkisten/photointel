"""Authenticated, bounded GPU HTTP application without database access."""

import secrets
from typing import Protocol

from fastapi import FastAPI, HTTPException, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from gpu.pipelines.contracts import (
    MAX_REQUEST_BYTES,
    ImageRequest,
    ImageResponse,
    ModelSpec,
    TextEmbedding,
    TextRequest,
)


class ModelRuntime(Protocol):
    def infer(self, request: ImageRequest) -> ImageResponse: ...
    def embed_text(self, text: str) -> TextEmbedding: ...


def create_service(models: ModelRuntime, spec: ModelSpec, token: str) -> FastAPI:
    if len(token) < 32:
        raise ValueError("Inference bearer token requires 32+ characters")
    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    async def payload(
        request: Request, schema: type[ImageRequest] | type[TextRequest]
    ) -> ImageRequest | TextRequest:
        authorization = request.headers.get("authorization", "")
        if not secrets.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(401, "Unauthorized inference service")
        total = 0
        chunks: list[bytes] = []
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_REQUEST_BYTES:
                raise HTTPException(413, "Inference request exceeds limit")
            chunks.append(chunk)
        try:
            value = schema.model_validate_json(b"".join(chunks))
            if value.models != spec:
                raise ValueError("Model revision mismatch")
            return value
        except (ValidationError, ValueError) as exc:
            # Pydantic errors contain input values; never return image/query payloads.
            raise HTTPException(422, "Invalid scoped inference request") from exc

    @api.post("/infer-images")
    async def infer_images(request: Request) -> dict:
        value = await payload(request, ImageRequest)
        assert isinstance(value, ImageRequest)
        try:
            result = await run_in_threadpool(models.infer, value)
            return ImageResponse.model_validate(result).model_dump(mode="json")
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(422, "Inference failed validation or execution") from exc

    @api.post("/embed-text")
    async def embed_text(request: Request) -> dict:
        value = await payload(request, TextRequest)
        assert isinstance(value, TextRequest)
        try:
            result = await run_in_threadpool(models.embed_text, value.text)
            return TextEmbedding.model_validate(result).model_dump(mode="json")
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(422, "Embedding failed validation or execution") from exc

    return api
