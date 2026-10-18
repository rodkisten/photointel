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


async def validate_jwt(
    token: str, settings: Settings, audience: str, required: list[str]
) -> dict[str, Any]:
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
            audience=audience,
            options={"require": required},
            leeway=10,
        )
        return claims
    except (jwt.PyJWTError, KeyError, ValueError, TypeError) as exc:
        raise AppError(
            ErrorCode.UNAUTHORIZED, "Autenticação inválida ou expirada", 401
        ) from exc


async def validate_access_token(token: str, settings: Settings) -> Identity:
    claims = await validate_jwt(
        token,
        settings,
        settings.access_audience,
        ["exp", "iat", "iss", "aud", "sub", "email"],
    )
    email = claims.get("email")
    subject = claims.get("sub")
    if not isinstance(email, str) or not isinstance(subject, str) or not subject:
        raise AppError(ErrorCode.UNAUTHORIZED, "Identidade Access inválida", 401)
    if email.casefold() not in {
        value.casefold() for value in settings.access_allowed_emails
    }:
        raise AppError(ErrorCode.FORBIDDEN, "Identidade não autorizada", 403)
    return Identity(subject=subject, email=email.casefold())


async def require_bridge_access(request: Request) -> None:
    """Validate the edge service identity even through the direct Cloud Run URL.

    A Cloudflare Service Auth JWT intentionally has no email and an empty sub.
    Its exact common_name (Client ID) and separate application audience are scoped
    to Bridge endpoints. The device Bearer or enrollment code is still required.
    """
    settings = get_settings()
    check_origin(request, settings)
    if settings.auth_mode == "local" and settings.app_env in {"development", "test"}:
        return
    # Production never assumes a Tunnel or Cloudflare network hop performed auth.
    if not settings.access_bridge_audience or not settings.access_bridge_service_tokens:
        raise AppError(ErrorCode.UNAUTHORIZED, "Access do Bridge não configurado", 503)
    token = request.headers.get("cf-access-jwt-assertion")
    if not token:
        raise AppError(ErrorCode.UNAUTHORIZED, "Autenticação Access necessária", 401)
    claims = await validate_jwt(
        token,
        settings,
        settings.access_bridge_audience,
        ["exp", "iat", "iss", "aud", "sub", "common_name"],
    )
    # mTLS identities also have common_name; they are not service-token identities.
    common_name = claims.get("common_name")
    if claims.get("sub") != "" or not isinstance(common_name, str):
        raise AppError(ErrorCode.UNAUTHORIZED, "Token de serviço Access inválido", 401)
    if common_name not in settings.access_bridge_service_tokens:
        raise AppError(ErrorCode.FORBIDDEN, "Serviço Bridge não autorizado", 403)


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
