"""Private FastAPI origin. Local development auth is forbidden in production."""

import asyncio
import logging
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID, uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from photointel.config import get_settings
from photointel.database import SessionLocal, engine
from photointel.errors import AppError, ErrorCode, error_response
from photointel.observability import correlation_context
from photointel.sentry_observability import capture_exception, configure_sentry
from photointel.storage import S3Storage, get_storage

logger = logging.getLogger("photointel.api")
_requests: dict[str, deque[float]] = defaultdict(deque)


@asynccontextmanager
async def lifespan(app: FastAPI) -> Any:
    settings = get_settings()  # Revalidate startup invariants before serving traffic.
    from photointel.logging import configure_logging

    configure_logging(settings.log_level)
    configure_sentry('photointel-api')
    logger.info("api_started", extra={"environment": settings.app_env})
    yield
    await engine.dispose()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Photo Intelligence Cloud",
        version="1.1.0",
        description="Catálogo privado, metadata, jobs e inteligência visual.",
        lifespan=lifespan,
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None if settings.is_production else "/redoc",
        openapi_url=None if settings.is_production else "/openapi.json",
    )
    origins = list({settings.frontend_origin, *settings.cors_origins})
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Content-Type",
            "Cf-Access-Jwt-Assertion",
            "Authorization",
            "Last-Event-ID",
            "If-None-Match",
            "If-Range",
            "Range",
            "X-Correlation-ID",
            "Sentry-Trace",
            "Baggage",
        ],
        expose_headers=[
            "ETag", "Content-Length", "Content-Range", "Accept-Ranges",
            "X-Correlation-ID", "X-Sentry-Event-ID",
        ],
    )

    @app.exception_handler(AppError)
    async def application_error(request: Request, exc: AppError) -> JSONResponse:
        if exc.status_code >= 500:
            request.state.sentry_event_id = capture_exception(
                exc, correlation_id=request.state.correlation_id,
                error_code=exc.code,
            )
        return error_response(request, exc)

    @app.exception_handler(RequestValidationError)
    async def validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # Validation inputs may contain credentials; do not serialize Pydantic input/ctx.
        issues = [
            {"path": list(item["loc"]), "type": item["type"]}
            for item in exc.errors()[:100]
        ]
        return error_response(
            request,
            AppError(
                ErrorCode.INVALID_REQUEST,
                "Dados inválidos",
                422,
                {"issues": issues},
            ),
        )

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        request.state.sentry_event_id = capture_exception(
            exc, correlation_id=request.state.correlation_id,
            error_code="INTERNAL_ERROR",
        )
        logger.error(
            "request_failed",
            extra={
                "correlation_id": request.state.correlation_id,
                "exception_type": type(exc).__name__,
            },
        )
        return error_response(
            request,
            AppError(
                ErrorCode.INTERNAL_ERROR,
                "Falha interna; consulte o diagnóstico pelo ID",
                500,
            ),
        )

    @app.middleware("http")
    async def protection(request: Request, call_next: Any) -> Any:
        import time

        # Accept only canonical UUIDs propagated by the trusted edge.
        # Never log caller-controlled arbitrary strings or expose credentials.
        incoming_correlation = request.headers.get("x-correlation-id", "")
        try:
            parsed_correlation = str(UUID(incoming_correlation))
            request.state.correlation_id = (
                parsed_correlation if incoming_correlation == parsed_correlation else str(uuid4())
            )
        except (ValueError, AttributeError):
            request.state.correlation_id = str(uuid4())
        # Inherit the trusted edge UUID into jobs enqueued in this request.
        correlation_context.set(request.state.correlation_id)
        if request.method in {"POST", "PUT", "PATCH"}:
            try:
                length = int(request.headers.get("content-length", "0"))
            except ValueError:
                return error_response(
                    request,
                    AppError(
                        ErrorCode.INVALID_REQUEST,
                        "Tamanho de requisição inválido",
                        400,
                    ),
                )
            if length > 1024 * 1024:
                return error_response(
                    request,
                    AppError(
                        ErrorCode.INVALID_REQUEST,
                        "Requisição excede 1 MiB",
                        413,
                    ),
                )
            # Bound chunked bodies too. No original photos are uploaded via this API.
            collected = bytearray()
            async for chunk in request.stream():
                if len(collected) + len(chunk) > 1024 * 1024:
                    return error_response(
                        request,
                        AppError(
                            ErrorCode.INVALID_REQUEST,
                            "Requisição excede 1 MiB",
                            413,
                        ),
                    )
                collected.extend(chunk)
            request._body = bytes(collected)
            client = request.client.host if request.client else "unknown"
            now = time.monotonic()
            attempts = _requests[client]
            while attempts and attempts[0] < now - 60:
                attempts.popleft()
            if len(attempts) >= 120:
                return error_response(
                    request,
                    AppError(
                        ErrorCode.RATE_LIMITED,
                        "Muitas operações; aguarde um minuto",
                        429,
                    ),
                )
            attempts.append(now)
            if len(_requests) > 10000:
                expired = [
                    key
                    for key, values in _requests.items()
                    if not values or values[-1] < now - 60
                ]
                for key in expired:
                    _requests.pop(key, None)
        response = await call_next(request)
        if response.status_code >= 400:
            # GCP Logs Explorer can always find the correlation ID of an API error.
            # Never emit private URLs, query strings, request bodies or JWTs.
            logger.warning(
                "api_http_error",
                extra={
                    "correlation_id": request.state.correlation_id,
                    "status_code": response.status_code,
                    "method": request.method,
                    "route_group": "/v1/*" if request.url.path.startswith("/v1/") else "other",
                },
            )
        response.headers["X-Correlation-ID"] = request.state.correlation_id
        event_id = getattr(request.state, "sentry_event_id", None)
        if event_id:
            response.headers["X-Sentry-Event-ID"] = event_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/v1"):
            response.headers["Cache-Control"] = "private, no-store"
        return response

    @app.get("/health/live", tags=["health"])
    async def live() -> dict[str, str]:
        return {"status": "alive"}

    @app.get("/health/ready", tags=["health"])
    async def ready() -> dict[str, str]:
        # Do not return sensitive provider details on this unauthenticated route.
        # Emit only a fixed component marker and exception class to Cloud Logging.
        # Check both dependencies even if one fails, so operations can distinguish
        # simultaneous Neon and R2 outages in a single diagnostic run.
        failed = False
        try:
            async with SessionLocal() as session:
                await asyncio.wait_for(session.execute(text("SELECT 1")), timeout=10)
        except Exception as exc:
            logger.error(
                "readiness_neon_failed",
                extra={"exception_type": type(exc).__name__},
            )
            failed = True
        try:
            storage = get_storage()
            if isinstance(storage, S3Storage):
                await asyncio.wait_for(
                    asyncio.to_thread(
                        storage.client.head_bucket,
                        Bucket=storage.bucket,
                    ),
                    timeout=12,
                )
        except Exception as exc:
            logger.error(
                "readiness_r2_failed",
                extra={"exception_type": type(exc).__name__},
            )
            failed = True
        if failed:
            raise AppError(
                ErrorCode.DATABASE_UNAVAILABLE,
                "Dependência indisponível",
                503,
            )
        return {"status": "ready"}

    from photointel.routers.catalog import router as catalog
    from photointel.routers.operations import router as operations

    app.include_router(catalog, prefix="/v1")
    from photointel.routers.observability import router as observability

    app.include_router(observability, prefix="/v1")
    app.include_router(operations, prefix="/v1")
    from photointel.routers.bridge import router as bridge

    app.include_router(bridge, prefix="/v1")
    from photointel.routers.readiness import router as readiness

    app.include_router(readiness, prefix="/v1")
    return app


app = create_app()
