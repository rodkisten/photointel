"""Deploy explicitly with `uv run --group gpu modal deploy gpu/modal_app.py`."""

import os
from pathlib import Path

import modal

from gpu.pipelines.contracts import ModelSpec

app = modal.App("photo-intelligence-v1")
cache = modal.Volume.from_name("photo-intelligence-models-v1", create_if_missing=True)
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "torch==2.7.1",
        "torchvision==0.22.1",
        "transformers==4.53.3",
        "huggingface-hub==0.33.4",
        "safetensors==0.5.3",
        "einops==0.8.1",
        "sentencepiece==0.2.0",
        "pillow==11.3.0",
        "fastapi==0.116.1",
        "pydantic==2.11.7",
    )
    .add_local_python_source("gpu")
)


@app.cls(
    image=image,
    gpu="T4",
    volumes={"/models": cache},
    secrets=[modal.Secret.from_name("photo-intelligence-inference")],
    timeout=600,
    scaledown_window=60,
    min_containers=0,
    max_containers=1,
)
@modal.concurrent(max_inputs=1)
class InferenceService:
    @modal.enter()
    def load(self) -> None:
        from gpu.models.adapters import RealModels

        token = os.environ.get("INFERENCE_SERVICE_TOKEN", "")
        if len(token) < 32:
            raise RuntimeError("INFERENCE_SERVICE_TOKEN requires 32+ characters")
        self.token = token
        self.spec = ModelSpec(
            joytag_revision=os.environ["JOYTAG_MODEL_REVISION"],
            siglip_revision=os.environ["SIGLIP_MODEL_REVISION"],
        )
        self.models = RealModels(self.spec, Path("/models"), device="cuda")
        cache.commit()

    @modal.asgi_app(requires_proxy_auth=True)
    def web(self):
        from gpu.service import create_service

        return create_service(self.models, self.spec, self.token)
