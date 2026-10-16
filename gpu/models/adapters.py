"""Real JoyTag and SigLIP 2 execution. Importing this module never downloads models."""

import base64
import binascii
import hashlib
import io
import json
import time
from collections import OrderedDict
from contextlib import nullcontext
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

from gpu.pipelines.contracts import (
    EMBEDDING_DIMENSION,
    MAX_IMAGE_BYTES,
    ImageRequest,
    ImageResponse,
    ImageResult,
    ModelSpec,
    TextEmbedding,
    validate_revision,
)


def decode_image(encoded: str) -> Image.Image:
    try:
        data = base64.b64decode(encoded, validate=True)
        if len(data) > MAX_IMAGE_BYTES:
            raise ValueError("Image exceeds inference size limit")
        with Image.open(io.BytesIO(data)) as source:
            if source.width * source.height > 24_000_000:
                raise ValueError("Inference image exceeds pixel limit")
            source.load()
            return ImageOps.exif_transpose(source).convert("RGB")
    except (
        binascii.Error,
        UnidentifiedImageError,
        OSError,
        Image.DecompressionBombError,
    ) as exc:
        raise ValueError("Invalid or corrupt inference image") from exc


def joytag_prepare(image: Image.Image, size: int) -> Any:
    """Official JoyTag white-square/BICUBIC/CLIP normalization, no center crop."""
    import torchvision.transforms.functional as tvf

    image = image.convert("RGB")
    edge = max(image.size)
    square = Image.new("RGB", (edge, edge), (255, 255, 255))
    square.paste(image, ((edge - image.width) // 2, (edge - image.height) // 2))
    if edge != size:
        square = square.resize((size, size), Image.Resampling.BICUBIC)
    tensor = tvf.pil_to_tensor(square).float() / 255
    return tvf.normalize(
        tensor,
        mean=[0.48145466, 0.4578275, 0.40821073],
        std=[0.26862954, 0.26130258, 0.27577711],
    )


class RealModels:
    """Models loaded once per container/process and reused across bounded batches."""

    def __init__(self, models: ModelSpec, cache: Path, device: str = "cuda") -> None:
        import torch
        from huggingface_hub import snapshot_download
        from transformers import AutoModel, AutoProcessor

        from gpu.models.joytag_upstream import VisionModel

        self.spec = models
        self.device = device
        self.torch = torch
        # Bounded warm-container deduplication for uncertain HTTP retries. It is
        # additional to durable backend idempotency and contains no source bytes.
        self.result_cache: OrderedDict[str, ImageResponse] = OrderedDict()
        self.text_cache: OrderedDict[str, TextEmbedding] = OrderedDict()
        for revision in (models.joytag_revision, models.siglip_revision):
            validate_revision(revision)
        joy_path = Path(
            snapshot_download(
                repo_id=models.joytag_model_id,
                revision=models.joytag_revision,
                cache_dir=str(cache),
                allow_patterns=[
                    "config.json",
                    "model.safetensors",
                    "top_tags.txt",
                ],
            )
        )
        # Unsafe pickle checkpoints are deliberately unsupported.
        if not (joy_path / "model.safetensors").is_file():
            raise ValueError("Pinned JoyTag checkpoint must contain model.safetensors")
        self.vocabulary = [
            tag.strip()
            for tag in (joy_path / "top_tags.txt").read_text().splitlines()
            if tag.strip()
        ]
        config = json.loads((joy_path / "config.json").read_text())
        if config.get("n_tags") != len(self.vocabulary):
            raise ValueError("JoyTag checkpoint vocabulary dimension mismatch")
        self.joytag = VisionModel.load_model(joy_path, device=device).eval()
        self.processor = AutoProcessor.from_pretrained(
            models.siglip_model_id,
            revision=models.siglip_revision,
            cache_dir=str(cache),
            trust_remote_code=False,
        )
        self.siglip = (
            AutoModel.from_pretrained(
                models.siglip_model_id,
                revision=models.siglip_revision,
                cache_dir=str(cache),
                trust_remote_code=False,
                use_safetensors=True,
            )
            .to(device)
            .eval()
        )
        # The DB migration uses vector(768) for this exact supported checkpoint.
        # Validate checkpoint config rather than assuming every SigLIP variant matches.
        vision_dim = self.siglip.config.vision_config.hidden_size
        text_dim = self.siglip.config.text_config.hidden_size
        if vision_dim != EMBEDDING_DIMENSION or text_dim != EMBEDDING_DIMENSION:
            raise ValueError("Checkpoint dimensions require a new database migration")

    def _autocast(self) -> Any:
        if self.device == "cuda":
            return self.torch.autocast("cuda", dtype=self.torch.float16)
        return nullcontext()

    def _sync(self) -> None:
        if self.device == "cuda":
            self.torch.cuda.synchronize()

    def infer(self, request: ImageRequest) -> ImageResponse:
        if request.models != self.spec:
            raise ValueError("Request revision differs from loaded model revision")
        identity = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
        cached = self.result_cache.get(identity)
        if cached is not None:
            self.result_cache.move_to_end(identity)
            return cached
        started = time.perf_counter()
        results: list[ImageResult] = []
        for offset in range(0, len(request.images), request.batch_size):
            items = request.images[offset : offset + request.batch_size]
            images = [decode_image(item.image_base64) for item in items]
            image_batch = self.torch.stack(
                [joytag_prepare(image, self.joytag.image_size) for image in images]
            ).to(self.device)
            self._sync()
            tag_started = time.perf_counter()
            with self.torch.inference_mode(), self._autocast():
                logits = self.joytag({"image": image_batch})["tags"]
                probabilities = logits.sigmoid().float().cpu().tolist()
            self._sync()
            joytag_ms = (time.perf_counter() - tag_started) * 1000 / len(items)
            inputs = self.processor(images=images, return_tensors="pt").to(self.device)
            embed_started = time.perf_counter()
            with self.torch.inference_mode(), self._autocast():
                features = self.siglip.get_image_features(**inputs)
                embeddings = (
                    self.torch.nn.functional.normalize(
                        features.float(),
                        dim=-1,
                    )
                    .cpu()
                    .tolist()
                )
            self._sync()
            embedding_ms = (time.perf_counter() - embed_started) * 1000 / len(items)
            for item, prediction, embedding in zip(
                items,
                probabilities,
                embeddings,
                strict=True,
            ):
                if len(prediction) != len(self.vocabulary):
                    raise ValueError("JoyTag output dimension mismatch")
                results.append(
                    ImageResult(
                        asset_id=item.asset_id,
                        input_revision=item.input_revision,
                        model_revision=self.spec.siglip_revision,
                        joytag_revision=self.spec.joytag_revision,
                        embedding=embedding,
                        probabilities=dict(zip(self.vocabulary, prediction, strict=True)),
                        runtime_ms=embedding_ms,
                        joytag_runtime_ms=joytag_ms,
                    )
                )
        response = ImageResponse(
            results=results,
            total_runtime_ms=(time.perf_counter() - started) * 1000,
        )
        self.result_cache[identity] = response
        while len(self.result_cache) > 8:
            self.result_cache.popitem(last=False)
        return response

    def embed_text(self, text: str) -> TextEmbedding:
        identity = hashlib.sha256(text.encode()).hexdigest()
        cached = self.text_cache.get(identity)
        if cached is not None:
            self.text_cache.move_to_end(identity)
            return cached
        started = time.perf_counter()
        # SigLIP's processor uses its pinned tokenizer, max_length padding and EOS.
        inputs = self.processor(
            text=[text],
            padding="max_length",
            truncation=True,
            max_length=64,
            return_tensors="pt",
        ).to(self.device)
        with self.torch.inference_mode(), self._autocast():
            feature = self.siglip.get_text_features(**inputs)
            vector = (
                self.torch.nn.functional.normalize(
                    feature.float(),
                    dim=-1,
                )[0]
                .cpu()
                .tolist()
            )
        self._sync()
        result = TextEmbedding(
            embedding=vector,
            model_revision=self.spec.siglip_revision,
            runtime_ms=(time.perf_counter() - started) * 1000,
        )
        self.text_cache[identity] = result
        while len(self.text_cache) > 128:
            self.text_cache.popitem(last=False)
        return result
