"""Cloudflare Access JWT validation. Origin headers alone grant no identity."""

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from fastapi import Request

from photointel.config import Settings, get_settings
from photointel.errors import AppError, ErrorCode


@dataclass(frozen=True)
class Identity:
    subject: str
    email: str


@dataclass
class KeyCache:
    keys: list[dict[str, Any]]
    expires_at: float


_key_cache: dict[str, KeyCache] = {}
_cache_lock = asyncio.Lock()


def issuer_for(settings: Settings) -> str:
    domain = settings.access_team_domain.removeprefix("https://").rstrip("/")
    if not re.fullmatch(r"[a-z0-9-]+\.cloudflareaccess\.com", domain):
        raise AppError(ErrorCode.UNAUTHORIZED, "Configuração Access inválida", 503)
    return f"https://{domain}"


async def fetch_keys(
    issuer: str, cache_seconds: int, force: bool = False
) -> list[dict[str, Any]]:
    async with _cache_lock:
        cached = _key_cache.get(issuer)
        now = time.monotonic()
        if cached and cached.expires_at > now:
            refreshed_at = cached.expires_at - cache_seconds
            # Unknown-key tokens must not turn each GET into a remote JWKS call.
            if not force or now - refreshed_at < 10:
                return cached.keys
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                response = await client.get(f"{issuer}/cdn-cgi/access/certs")
                response.raise_for_status()
                if len(response.content) > 1024 * 1024:
                    raise ValueError("JWT key response exceeds limit")
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError("Invalid JWT key response")
                keys = payload.get("keys", [])
            if (
                not isinstance(keys, list)
                or not 1 <= len(keys) <= 64
                or any(not isinstance(key, dict) for key in keys)
            ):
                raise ValueError("No valid JWT keys")
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise AppError(
                ErrorCode.UNAUTHORIZED, "Validação Access indisponível", 503
            ) from exc
        _key_cache[issuer] = KeyCache(
            keys=keys, expires_at=time.monotonic() + cache_seconds
        )
        return keys


async def validate_access_token(token: str, settings: Settings) -> Identity:
    if len(token) > 16384:
        raise AppError(ErrorCode.UNAUTHORIZED, "Token de autenticação inválido", 401)
    issuer = issuer_for(settings)
    try:
        header = jwt.get_unverified_header(token)
        key_id = header.get("kid")
        if (
            header.get("alg") != "RS256"
            or not isinstance(key_id, str)
            or not 1 <= len(key_id) <= 256
        ):
            raise jwt.InvalidTokenError("Invalid key selection")
        keys = await fetch_keys(issuer, settings.access_jwks_cache_seconds)
        key = next((k for k in keys if k.get("kid") == key_id), None)
        if key is None:
            keys = await fetch_keys(
                issuer, settings.access_jwks_cache_seconds, force=True
            )
            key = next((k for k in keys if k.get("kid") == key_id), None)
        if key is None:
            raise jwt.InvalidTokenError("Unknown key")
        signing_key = jwt.PyJWK.from_dict(key, algorithm="RS256").key
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            issuer=issuer,
            audience=settings.access_audience,
            options={"require": ["exp", "iat", "iss", "aud", "sub", "email"]},
            leeway=10,
        )
        email = str(claims["email"]).casefold()
        if email not in {value.casefold() for value in settings.access_allowed_emails}:
            raise AppError(ErrorCode.FORBIDDEN, "Identidade não autorizada", 403)
        return Identity(subject=str(claims["sub"]), email=email)
    except (jwt.PyJWTError, KeyError, ValueError, TypeError) as exc:
        raise AppError(
            ErrorCode.UNAUTHORIZED, "Autenticação inválida ou expirada", 401
        ) from exc


def check_origin(request: Request, settings: Settings) -> None:
    if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return
    # Browser cookie requests must have an authorized Origin. Explicit JWT API
    # requests can omit Origin, but a supplied foreign Origin is always rejected.
    origin = request.headers.get("origin")
    explicit_token = request.headers.get("cf-access-jwt-assertion")
    allowed = {settings.frontend_origin.rstrip("/"), *settings.cors_origins}
    if origin and origin.rstrip("/") not in allowed:
        raise AppError(ErrorCode.FORBIDDEN, "Origem da requisição não autorizada", 403)
    if settings.is_production and not origin and not explicit_token:
        raise AppError(
            ErrorCode.FORBIDDEN, "Origem obrigatória para operações de escrita", 403
        )


async def require_identity(request: Request) -> Identity:
    settings = get_settings()
    check_origin(request, settings)
    if settings.auth_mode == "local":
        if settings.app_env not in {"development", "test"}:
            raise AppError(ErrorCode.UNAUTHORIZED, "Modo local indisponível", 401)
        return Identity(subject="local-development", email=settings.local_identity_email)
    token = request.headers.get("cf-access-jwt-assertion") or request.cookies.get(
        "CF_Authorization"
    )
    if not token:
        raise AppError(ErrorCode.UNAUTHORIZED, "Autenticação necessária", 401)
    return await validate_access_token(token, settings)
