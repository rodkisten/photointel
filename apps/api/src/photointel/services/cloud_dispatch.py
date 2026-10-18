"""Authenticated, fixed-name Cloud Run Jobs invocation using workload identity.

The durable PostgreSQL outbox owns delivery. An ambiguous HTTP failure may have
started an execution; repeated executions must claim the same PostgreSQL queue
atomically. This module never accepts commands, job overrides or caller URLs.
"""

import asyncio
import os
import re
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from photointel.errors import AppError, ErrorCode

JobMode = Literal["discover", "backfill", "worker", "maintenance"]
ALLOWED_MODES = frozenset({"discover", "backfill", "worker", "maintenance"})
SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


@dataclass(frozen=True)
class DispatchConfiguration:
    project: str
    region: str
    enabled: bool = False

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", self.project):
            raise ValueError("Invalid Google Cloud project ID")
        if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]", self.region):
            raise ValueError("Invalid Google Cloud region")

    @classmethod
    def from_environment(cls) -> "DispatchConfiguration":
        return cls(
            project=os.environ.get("GCP_PROJECT_ID", ""),
            region=os.environ.get("GCP_REGION", ""),
            enabled=os.environ.get("GCP_JOB_DISPATCH_ENABLED", "false").lower() == "true",
        )

    def endpoint(self, mode: JobMode) -> str:
        if mode not in ALLOWED_MODES:
            raise ValueError("Cloud Run job name is not allowlisted")
        return (
            f"https://run.googleapis.com/v2/projects/{self.project}/locations/"
            f"{self.region}/jobs/photointel-{mode}:run"
        )


class GoogleJobDispatcher:
    def __init__(self, configuration: DispatchConfiguration) -> None:
        self.configuration = configuration
        self._credentials: Any = None
        self._lock = asyncio.Lock()

    async def _access_token(self) -> str:
        async with self._lock:
            return await asyncio.to_thread(self._refresh_credentials)

    def _refresh_credentials(self) -> str:
        # ADC resolves the Cloud Run service identity; no downloaded key is needed.
        import google.auth
        from google.auth.transport.requests import Request

        if self._credentials is None:
            self._credentials, _ = google.auth.default(scopes=SCOPES)
        if not self._credentials.valid:
            self._credentials.refresh(Request())
        token = self._credentials.token
        if not isinstance(token, str) or not token:
            raise RuntimeError("Google service identity returned no access token")
        return token

    async def dispatch(self, mode: JobMode) -> str:
        endpoint = self.configuration.endpoint(mode)
        if not self.configuration.enabled:
            raise AppError(ErrorCode.FORBIDDEN, "Despacho Cloud Run está desativado", 409)
        try:
            token = await self._access_token()
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(20, connect=5), follow_redirects=False
            ) as client:
                response = await client.post(
                    endpoint,
                    headers={"Authorization": f"Bearer {token}"},
                    json={},
                )
            if response.status_code not in {200, 201, 202}:
                raise AppError(
                    ErrorCode.INTERNAL_ERROR,
                    "Cloud Run não confirmou o despacho; consulte o outbox e IAM",
                    503,
                    {"provider_status": response.status_code},
                )
            if len(response.content) > 64 * 1024:
                raise ValueError("Oversized Google Jobs API response")
            name = response.json().get("name", "")
            prefix = (
                f"projects/{self.configuration.project}/locations/"
                f"{self.configuration.region}/operations/"
            )
            if (
                not isinstance(name, str)
                or not name.startswith(prefix)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", name[len(prefix) :])
            ):
                raise ValueError("Invalid Google Jobs operation identity")
            return name
        except AppError:
            raise
        except Exception as exc:
            # Provider/credential exception messages can contain credential details.
            raise AppError(
                ErrorCode.INTERNAL_ERROR,
                "Despacho Cloud Run não confirmado; operação será reconciliada",
                503,
            ) from exc
