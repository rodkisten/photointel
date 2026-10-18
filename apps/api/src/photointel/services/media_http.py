"""Private revision-aware media HTTP rules; authorization precedes every response."""

import asyncio
import re
from hashlib import sha256
from typing import Any

from fastapi.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from photointel.errors import AppError, ErrorCode
from photointel.storage import ObjectStream


class PrivateStreamingResponse(StreamingResponse):
    """Close provider streams even if a client disconnects before body iteration."""

    def __init__(self, stream: ObjectStream, **kwargs: Any) -> None:
        self.object_stream = stream
        super().__init__(stream.chunks(), **kwargs)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await asyncio.to_thread(self.object_stream.close)


def media_etag(resource_id: str, revision: str, checksum: str | None) -> str:
    token = sha256(f"{resource_id}:{revision}:{checksum or ''}".encode()).hexdigest()
    return f'"{token}"'


def matches_etag(header: str | None, etag: str) -> bool:
    if not header or len(header) > 4096:
        return False
    return any(
        item.strip().removeprefix("W/") in {"*", etag} for item in header.split(",")
    )


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """Accept one RFC 9110 byte range, with bounded numeric input and output."""
    if header is None:
        return None
    match = re.fullmatch(r"bytes=(\d{0,20})-(\d{0,20})", header)
    if not match or size <= 0 or not any(match.groups()):
        raise AppError(ErrorCode.INVALID_REQUEST, "Intervalo de mídia inválido", 416)
    left, right = match.groups()
    if not left:
        suffix = int(right)
        if suffix <= 0:
            raise AppError(ErrorCode.INVALID_REQUEST, "Intervalo de mídia inválido", 416)
        return max(0, size - suffix), size - 1
    start = int(left)
    end = min(int(right), size - 1) if right else size - 1
    if start >= size or end < start:
        raise AppError(ErrorCode.INVALID_REQUEST, "Intervalo de mídia inválido", 416)
    return start, end
