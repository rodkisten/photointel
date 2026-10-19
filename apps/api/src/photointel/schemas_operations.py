"""Operational response contracts shared through generated OpenAPI types."""

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel


class SetupCheck(BaseModel):
    id: str
    label: str
    state: str
    reason: str
    action: str
    href: str


class SetupNextAction(BaseModel):
    label: str
    href: str
    description: str


class SpendingState(BaseModel):
    enabled: bool
    gpu_enabled: bool


class SetupStatus(BaseModel):
    checks: list[SetupCheck]
    next_action: SetupNextAction | None
    spending: SpendingState
    checked_at: datetime


class VerificationGateOut(BaseModel):
    id: str
    name: str
    status: str
    reason: str
    evidence: list[str]
    verified_at: datetime | None
    requirements: list[str]


class VerificationGates(BaseModel):
    items: list[VerificationGateOut]
    full_backfill_unlocked: bool


class IngestionFailure(BaseModel):
    asset_id: UUID
    filename: str
    status: str
    failure_category: str | None
    error_code: str | None
    error_details: dict[str, Any] | None
    attempts: int
    maximum_attempts: int
    updated_at: datetime


class IngestionFailures(BaseModel):
    items: list[IngestionFailure]
    next_cursor: str | None


class ModelRelease(BaseModel):
    revision: str | None


class ReleaseTest(BaseModel):
    name: str
    status: str
    reference: str
    git_sha: str


class ReleaseInfo(BaseModel):
    manifest_version: int
    git_sha: str | None
    branch: str | None
    build_timestamp: str | None
    container_digest: str | None
    frontend_release_id: str | None
    api_version: str
    database_migration_head: str | None
    models: dict[str, ModelRelease]
    modal_deployment_id: str | None
    infrastructure_hash: str | None
    ci_run_ids: list[str]
    test_results: list[ReleaseTest]
    provenance_status: str
    validation_status: str
    notice: str
