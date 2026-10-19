"""Validated settings. External integrations are disabled until configured."""

import re
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", case_sensitive=False
    )

    app_env: Literal["development", "test", "production"] = "development"
    auth_mode: Literal["local", "cloudflare"] = "local"
    frontend_origin: str = "http://localhost:5173"
    api_origin: str = "http://localhost:8000"
    database_url: str = (
        "postgresql+asyncpg://photointel:local-only@localhost:5432/photointel"
    )
    execution_platform: Literal["vps", "cloud_run"] = "vps"
    database_pool_mode: Literal["direct", "transaction"] = "direct"
    database_pool_size: int = Field(default=2, ge=1, le=20)
    database_max_overflow: int = Field(default=0, ge=0, le=10)
    database_pool_timeout_seconds: int = Field(default=15, ge=1, le=120)
    database_require_tls: bool = False
    database_tls_ca_file: Path | None = None
    database_profile: Literal["limited", "full"] = "limited"
    catalog_asset_limit: int = Field(default=1000, ge=1, le=10_000_000)
    migration_database_url: str | None = None
    log_level: str = "INFO"
    access_team_domain: str = ""
    access_audience: str = ""
    access_bridge_audience: str = ""
    access_bridge_service_tokens: list[str] = Field(default_factory=list)
    access_allowed_emails: list[str] = Field(default_factory=list)
    access_jwks_cache_seconds: int = Field(default=300, ge=30, le=3600)
    local_identity_email: str = "local@photointel.invalid"
    storage_backend: Literal["local", "s3", "r2"] = "local"
    storage_local_directory: Path = Path("var/media")
    storage_endpoint: str | None = None
    storage_bucket: str = "photointel-private"
    storage_region: str = "auto"
    storage_access_key: SecretStr | None = None
    storage_secret_key: SecretStr | None = None
    media_max_bytes: int = Field(default=20 * 1024 * 1024, ge=1024)
    signed_url_seconds: int = Field(default=60, ge=10, le=300)
    temp_directory: Path = Path("var/processing")
    icloud_account: str = ""
    icloud_library: str = ""
    icloud_session_directory: Path = Path("var/icloud-session")
    icloud_download_directory: Path = Path("var/icloud-downloads")
    icloud_enabled: bool = False
    icloud_session_backend: Literal["local", "encrypted_object"] = "local"
    icloud_session_key: SecretStr | None = None
    icloud_session_key_id: str = "v1"
    icloud_session_max_bytes: int = Field(default=8 * 1024 * 1024, ge=1024, le=67108864)
    icloud_session_lease_seconds: int = Field(default=180, ge=30, le=3600)
    icloud_session_max_age_hours: int = Field(default=720, ge=1, le=8760)
    initial_import_limit: int = Field(default=100, ge=1, le=10000)
    maximum_authorized_import_limit: int = Field(default=1000, ge=1, le=1_000_000)
    hard_import_limit: int = Field(default=10000, ge=1, le=1_000_000)
    verification_gates_enforced: bool = False
    ingestion_maximum_attempts: int = Field(default=5, ge=1, le=20)
    backfill_concurrency: int = Field(default=2, ge=1, le=16)
    incremental_overlap_assets: int = Field(default=100, ge=1, le=10000)
    reconciliation_interval_hours: int = Field(default=168, ge=24, le=8760)
    ingestion_interval_minutes: int = Field(default=60, ge=5, le=10080)
    ingestion_import_limit: int = Field(default=100, ge=1, le=1_000_000)
    download_representation: Literal["medium", "thumb", "original"] = "medium"
    allow_original_fallback: bool = False
    max_download_bytes: int = Field(default=20 * 1024 * 1024, ge=1024)
    max_run_download_bytes: int = Field(default=2000 * 1024 * 1024, ge=1024)
    reconcile_missing_scans: int = Field(default=3, ge=2)
    batch_size: int = Field(default=8, ge=1, le=128)
    worker_concurrency: int = Field(default=1, ge=1, le=32)
    job_lease_seconds: int = Field(default=300, ge=30, le=3600)
    job_heartbeat_seconds: int = Field(default=20, ge=5, le=120)
    job_poll_seconds: float = Field(default=2, ge=0.1, le=60)
    gpu_enabled: bool = False
    inference_backend: Literal["modal", "cpu", "test"] = "modal"
    modal_endpoint: str = ""
    modal_token: SecretStr | None = None
    modal_proxy_key: SecretStr | None = None
    modal_proxy_secret: SecretStr | None = None
    modal_timeout_seconds: int = Field(default=300, ge=30, le=1800)
    max_gpu_concurrency: int = Field(default=1, ge=1, le=16)
    gpu_max_assets_per_run: int = Field(default=100, ge=1, le=100000)
    gpu_hourly_cost_estimate: float = Field(default=0.6, ge=0)
    gpu_estimated_seconds_per_asset: float = Field(default=1, ge=0.01)
    gpu_max_cost_per_run: float = Field(default=1, ge=0)
    gpu_daily_budget: float = Field(default=2, ge=0)
    gpu_monthly_budget: float = Field(default=10, ge=0)
    joytag_model_id: str = "fancyfeast/joytag"
    joytag_model_revision: str = "6b7f16331a6ccf0fdce37d5a9564715f6e772b22"
    joytag_threshold: float = Field(default=0.4, ge=0, le=1)
    joytag_max_tags: int = Field(default=80, ge=1, le=1000)
    siglip_model_id: str = "google/siglip2-base-patch16-224"
    siglip_model_revision: str = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
    siglip_embedding_dimension: Literal[768] = 768
    model_cache_directory: Path = Path("var/model-cache")
    thumbnail_small_size: int = Field(default=240, ge=32, le=2048)
    thumbnail_medium_size: int = Field(default=640, ge=64, le=4096)
    preview_large_size: int = Field(default=1600, ge=128, le=8192)
    inference_input_size: int = Field(default=512, ge=128, le=2048)
    image_quality: int = Field(default=85, ge=20, le=100)
    temporary_retention_hours: int = Field(default=24, ge=1, le=8760)
    sensitive_tags_visible: bool = False
    bridge_enrollment_secret: SecretStr | None = None
    bridge_token_pepper: SecretStr | None = None
    apple_keyword_sync_mode: Literal["manual", "disabled"] = "manual"
    apple_bulk_write_enabled: bool = False
    apple_native_write_enabled: bool = False
    auto_delete_enabled: bool = False
    query_cache_enabled: bool = True
    query_cache_ttl_seconds: int = Field(default=86400, ge=30, le=2592000)
    query_cache_max_entries: int = Field(default=10000, ge=1, le=100000)
    query_cache_lease_seconds: int = Field(default=90, ge=10, le=1800)
    query_cache_wait_seconds: int = Field(default=30, ge=1, le=300)
    query_preprocessing_revision: str = "siglip2-transformers-5.10.2-v2"
    cors_origins: list[str] = Field(default_factory=list)

    @field_validator("siglip_embedding_dimension", mode="before")
    @classmethod
    def parse_siglip_embedding_dimension(cls, value: object) -> object:
        # Environment variables are strings; preserve the model's fixed dimension.
        return 768 if value == "768" else value

    @field_validator("frontend_origin", "api_origin")
    @classmethod
    def validate_origin(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise ValueError("Application origins must be HTTP(S) origins without paths")
        return value.rstrip("/")

    @field_validator("access_allowed_emails")
    @classmethod
    def validate_allowlist(cls, value: list[str]) -> list[str]:
        if len(value) > 100 or any(
            "@" not in email or len(email) > 254 or email.strip() != email
            for email in value
        ):
            raise ValueError("Access email allowlist is invalid")
        return list(dict.fromkeys(email.casefold() for email in value))

    @model_validator(mode="after")
    def secure_configuration(self) -> "Settings":
        if self.auto_delete_enabled:
            raise ValueError("Automatic deletion is not implemented or permitted")
        if self.initial_import_limit > self.maximum_authorized_import_limit:
            raise ValueError("Initial import limit exceeds the authorized maximum")
        if self.maximum_authorized_import_limit > self.hard_import_limit:
            raise ValueError("Authorized import limit exceeds the hard import limit")
        if self.execution_platform == "cloud_run" and self.app_env == "production":
            if not self.database_require_tls or not self.verification_gates_enforced:
                raise ValueError("Cloud Run production requires database TLS and gates")
            if self.icloud_enabled and self.icloud_session_backend != "encrypted_object":
                raise ValueError(
                    "Cloud Run iCloud requires encrypted persistent sessions"
                )
        if self.inference_backend == "test" and self.app_env != "test":
            raise ValueError("INFERENCE_BACKEND=test is only permitted with APP_ENV=test")
        if self.auth_mode == "cloudflare" and not re.fullmatch(
            r"(?:https://)?[a-z0-9-]+\.cloudflareaccess\.com/?",
            self.access_team_domain,
        ):
            raise ValueError("ACCESS_TEAM_DOMAIN must name a Cloudflare Access team")
        for origin in self.cors_origins:
            if origin == "*":
                raise ValueError("Wildcard CORS origins are not permitted")
            self.validate_origin(origin)
        if self.app_env == "production":
            if self.auth_mode != "cloudflare":
                raise ValueError("Production requires AUTH_MODE=cloudflare")
            if not all(
                (
                    self.access_team_domain,
                    self.access_audience,
                    self.access_allowed_emails,
                )
            ):
                raise ValueError(
                    "Configure Access team domain, audience and email allowlist"
                )
            if not self.frontend_origin.startswith("https://"):
                raise ValueError("Production FRONTEND_ORIGIN requires HTTPS")
            if not self.api_origin.startswith("https://"):
                raise ValueError("Production API_ORIGIN requires HTTPS")
            if "local-only" in self.database_url:
                raise ValueError("Production DATABASE_URL must replace local credentials")
            if self.storage_backend == "local":
                raise ValueError("Production requires private S3/R2 object storage")
            if (
                not self.bridge_token_pepper
                or len(self.bridge_token_pepper.get_secret_value()) < 32
            ):
                raise ValueError(
                    "Production BRIDGE_TOKEN_PEPPER must contain 32+ characters"
                )
        if self.storage_backend != "local" and not all(
            (self.storage_endpoint, self.storage_access_key, self.storage_secret_key)
        ):
            raise ValueError("S3/R2 requires endpoint and scoped storage credentials")
        if self.gpu_enabled and not all(
            re.fullmatch(r"[a-f0-9]{40}", revision)
            for revision in (self.joytag_model_revision, self.siglip_model_revision)
        ):
            raise ValueError(
                "GPU inference requires exact 40-character checkpoint revisions"
            )
        if (
            self.gpu_enabled
            and self.inference_backend == "modal"
            and not all(
                (
                    self.modal_endpoint,
                    self.modal_token,
                    self.modal_proxy_key,
                    self.modal_proxy_secret,
                )
            )
        ):
            raise ValueError(
                "Modal inference requires endpoint, application token "
                "and proxy credentials"
            )
        if (
            self.app_env == "production"
            and self.storage_endpoint
            and not self.storage_endpoint.startswith("https://")
        ):
            raise ValueError("Production object storage endpoint requires HTTPS")
        if self.gpu_enabled and self.inference_backend == "modal":
            if not self.modal_endpoint.startswith("https://"):
                raise ValueError("Modal endpoint requires HTTPS")
            if self.modal_token and len(self.modal_token.get_secret_value()) < 32:
                raise ValueError("MODAL_TOKEN must contain at least 32 characters")
        if self.job_heartbeat_seconds >= self.job_lease_seconds:
            raise ValueError(
                "JOB_HEARTBEAT_SECONDS must be shorter than JOB_LEASE_SECONDS"
            )
        return self

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
