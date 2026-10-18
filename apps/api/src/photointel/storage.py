"""Private object storage. API media handlers select database-owned object keys."""

import os
import re
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Any, Protocol
from uuid import UUID

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from photointel.config import get_settings
from photointel.errors import AppError, ErrorCode

STREAM_CHUNK_BYTES = 64 * 1024


class ReadableBody(Protocol):
    def read(self, size: int = -1) -> bytes: ...
    def close(self) -> None: ...


@dataclass
class ObjectStream:
    """A bounded object body. Iteration closes the provider connection on errors."""

    body: ReadableBody
    length: int

    def chunks(self) -> Iterator[bytes]:
        remaining = self.length
        try:
            while remaining:
                data = self.body.read(min(STREAM_CHUNK_BYTES, remaining))
                if not data:
                    raise AppError(
                        ErrorCode.STORAGE_UNAVAILABLE, "Imagem incompleta", 503
                    )
                if len(data) > min(STREAM_CHUNK_BYTES, remaining):
                    raise AppError(
                        ErrorCode.STORAGE_UNAVAILABLE, "Resposta de imagem inválida", 503
                    )
                remaining -= len(data)
                yield data
        except (BotoCoreError, OSError):
            raise AppError(
                ErrorCode.STORAGE_UNAVAILABLE, "Transferência de mídia interrompida", 503
            ) from None
        finally:
            self.close()

    def close(self) -> None:
        self.body.close()


class Storage(Protocol):
    def put(self, key: str, data: bytes, mime: str) -> None: ...
    def get(self, key: str) -> bytes: ...
    def open_stream(
        self, key: str, byte_range: tuple[int, int] | None = None
    ) -> ObjectStream: ...
    def delete(self, key: str) -> None: ...
    def presign_get(self, key: str, expires: int = 60) -> str: ...
    def exists(self, key: str) -> bool: ...


def validate_key(key: str) -> str:
    if (
        not key
        or len(key) > 1024
        or "\\" in key
        or "\x00" in key
        or key.startswith("/")
        or any(part in {"", ".", ".."} for part in key.split("/"))
        or not re.fullmatch(r"[A-Za-z0-9_./-]+", key)
    ):
        raise AppError(ErrorCode.INVALID_REQUEST, "Chave de armazenamento inválida", 400)
    return str(PurePosixPath(key))


def object_key(
    asset_id: str, revision: str, variant: str, extension: str = "webp"
) -> str:
    identifier = str(UUID(str(asset_id)))
    safe_revision = sha256(revision.encode()).hexdigest()[:24]
    allowed = {"thumbnail_small", "thumbnail_medium", "preview_large", "inference_input"}
    if variant not in allowed or extension not in {"webp", "jpg", "png"}:
        raise AppError(ErrorCode.INVALID_REQUEST, "Variante de imagem inválida", 400)
    return f"assets/{identifier}/{safe_revision}/{variant}.{extension}"


class LocalStorage:
    def __init__(self, directory: Path, max_read_bytes: int = 20 * 1024 * 1024) -> None:
        self.directory = directory.resolve()
        self.max_read_bytes = max_read_bytes
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _path(self, key: str) -> Path:
        path = (self.directory / validate_key(key)).resolve()
        if not path.is_relative_to(self.directory):
            raise AppError(ErrorCode.FORBIDDEN, "Acesso ao arquivo não permitido", 403)
        return path

    def put(self, key: str, data: bytes, mime: str) -> None:
        if len(data) > self.max_read_bytes:
            raise AppError(ErrorCode.INVALID_REQUEST, "Imagem excede limite local", 413)
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as handle:
                temporary = handle.name
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        finally:
            if temporary and Path(temporary).exists():
                Path(temporary).unlink()

    def get(self, key: str) -> bytes:
        try:
            with self._path(key).open("rb") as handle:
                data = handle.read(self.max_read_bytes + 1)
            if len(data) > self.max_read_bytes:
                raise AppError(
                    ErrorCode.STORAGE_UNAVAILABLE, "Imagem excede limite local", 503
                )
            return data
        except FileNotFoundError as exc:
            raise AppError(ErrorCode.NOT_FOUND, "Imagem indisponível", 404) from exc

    def open_stream(
        self, key: str, byte_range: tuple[int, int] | None = None
    ) -> ObjectStream:
        try:
            body = self._path(key).open("rb")
        except FileNotFoundError as exc:
            raise AppError(ErrorCode.NOT_FOUND, "Imagem indisponível", 404) from exc
        try:
            size = os.fstat(body.fileno()).st_size
            if size > self.max_read_bytes:
                raise AppError(
                    ErrorCode.STORAGE_UNAVAILABLE, "Imagem excede limite local", 503
                )
            start, end = byte_range if byte_range is not None else (0, size - 1)
            if start < 0 or end >= size or end < start:
                raise AppError(ErrorCode.INVALID_REQUEST, "Intervalo inválido", 416)
            body.seek(start)
            return ObjectStream(body, end - start + 1)
        except Exception:
            body.close()
            raise

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def presign_get(self, key: str, expires: int = 60) -> str:
        validate_key(key)
        raise AppError(
            ErrorCode.STORAGE_UNAVAILABLE,
            "Armazenamento local usa proxy autenticado; configure S3/R2 para acesso GPU",
            503,
        )


class S3Storage:
    def __init__(
        self,
        endpoint: str,
        bucket: str,
        access_key: str,
        secret_key: str,
        region: str = "auto",
        max_read_bytes: int = 20 * 1024 * 1024,
    ) -> None:
        self.bucket = bucket
        self.max_read_bytes = max_read_bytes
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=Config(
                signature_version="s3v4",
                retries={"max_attempts": 3},
                connect_timeout=10,
                read_timeout=30,
            ),
        )

    def put(self, key: str, data: bytes, mime: str) -> None:
        if len(data) > self.max_read_bytes:
            raise AppError(
                ErrorCode.INVALID_REQUEST, "Imagem excede limite configurado", 413
            )
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=validate_key(key),
                Body=data,
                ContentType=mime,
                CacheControl="private, no-store",
            )
        except (BotoCoreError, ClientError) as exc:
            raise AppError(
                ErrorCode.R2_UPLOAD_FAILED, "Falha ao salvar imagem privada", 503
            ) from exc

    def get(self, key: str) -> bytes:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=validate_key(key))
            with response["Body"] as body:
                if response.get("ContentLength", 0) > self.max_read_bytes:
                    raise AppError(
                        ErrorCode.STORAGE_UNAVAILABLE,
                        "Imagem excede limite configurado",
                        503,
                    )
                data = body.read(self.max_read_bytes + 1)
            if len(data) > self.max_read_bytes:
                raise AppError(
                    ErrorCode.STORAGE_UNAVAILABLE,
                    "Imagem excede limite configurado",
                    503,
                )
            return data
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                raise AppError(ErrorCode.NOT_FOUND, "Imagem indisponível", 404) from exc
            raise AppError(
                ErrorCode.STORAGE_UNAVAILABLE, "Armazenamento indisponível", 503
            ) from exc
        except BotoCoreError as exc:
            raise AppError(
                ErrorCode.STORAGE_UNAVAILABLE, "Armazenamento indisponível", 503
            ) from exc

    def open_stream(
        self, key: str, byte_range: tuple[int, int] | None = None
    ) -> ObjectStream:
        arguments: dict[str, Any] = {"Bucket": self.bucket, "Key": validate_key(key)}
        if byte_range is not None:
            start, end = byte_range
            if start < 0 or end < start or end >= self.max_read_bytes:
                raise AppError(ErrorCode.INVALID_REQUEST, "Intervalo inválido", 416)
            arguments["Range"] = f"bytes={start}-{end}"
        try:
            response = self.client.get_object(**arguments)
            body = response["Body"]
            length = response.get("ContentLength")
            if (
                not isinstance(length, int)
                or not 0 < length <= self.max_read_bytes
                or (byte_range is not None and length != end - start + 1)
            ):
                body.close()
                raise AppError(
                    ErrorCode.STORAGE_UNAVAILABLE, "Tamanho de imagem inválido", 503
                )
            # R2/S3 must honor a requested range, never pass a whole body as 206.
            if byte_range is not None and not response.get("ContentRange", "").startswith(
                f"bytes {start}-{end}/"
            ):
                body.close()
                raise AppError(
                    ErrorCode.STORAGE_UNAVAILABLE, "Intervalo de imagem inválido", 503
                )
            return ObjectStream(body, length)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                raise AppError(ErrorCode.NOT_FOUND, "Imagem indisponível", 404) from exc
            raise AppError(
                ErrorCode.STORAGE_UNAVAILABLE, "Armazenamento indisponível", 503
            ) from exc
        except BotoCoreError as exc:
            raise AppError(
                ErrorCode.STORAGE_UNAVAILABLE, "Armazenamento indisponível", 503
            ) from exc

    def delete(self, key: str) -> None:
        try:
            self.client.delete_object(Bucket=self.bucket, Key=validate_key(key))
        except (BotoCoreError, ClientError) as exc:
            raise AppError(
                ErrorCode.STORAGE_UNAVAILABLE, "Limpeza temporária falhou", 503
            ) from exc

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=validate_key(key))
            return True
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {
                "NoSuchKey",
                "404",
                "NotFound",
            }:
                return False
            raise AppError(
                ErrorCode.STORAGE_UNAVAILABLE, "Armazenamento indisponível", 503
            ) from exc
        except BotoCoreError as exc:
            raise AppError(
                ErrorCode.STORAGE_UNAVAILABLE, "Armazenamento indisponível", 503
            ) from exc

    def presign_get(self, key: str, expires: int = 60) -> str:
        if not 10 <= expires <= 300:
            raise AppError(ErrorCode.INVALID_REQUEST, "Expiração inválida", 400)
        try:
            return self.client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.bucket, "Key": validate_key(key)},
                ExpiresIn=expires,
            )
        except (BotoCoreError, ClientError) as exc:
            raise AppError(
                ErrorCode.STORAGE_UNAVAILABLE,
                "Autorização de mídia indisponível",
                503,
            ) from exc


@lru_cache
def get_storage() -> Storage:
    settings = get_settings()
    if settings.storage_backend == "local":
        return LocalStorage(settings.storage_local_directory, settings.media_max_bytes)
    assert (
        settings.storage_endpoint
        and settings.storage_access_key
        and settings.storage_secret_key
    )
    return S3Storage(
        endpoint=settings.storage_endpoint,
        bucket=settings.storage_bucket,
        access_key=settings.storage_access_key.get_secret_value(),
        secret_key=settings.storage_secret_key.get_secret_value(),
        region=settings.storage_region,
        max_read_bytes=settings.media_max_bytes,
    )
