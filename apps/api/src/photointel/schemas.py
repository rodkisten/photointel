"""Versioned application contracts, exported as OpenAPI for the PWA."""

from datetime import datetime
from typing import Any, Generic, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

T = TypeVar("T")


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class Page(Contract, Generic[T]):
    items: list[T]
    next_cursor: str | None = None


class ResourceOut(Contract):
    id: UUID
    asset_id: UUID
    resource_type: str
    mime_type: str | None
    byte_size: int | None
    width: int | None
    height: int | None
    revision: str
    status: str
    media_url: str | None = None


class TagOut(Contract):
    id: UUID
    canonical_key: str
    display_name: str
    category: str
    subcategory: str | None
    description: str | None
    is_sensitive: bool
    enabled: bool
    minimum_confidence: float
    parent_id: UUID | None
    merged_into_id: UUID | None
    sync_eligible: bool
    aliases: list[dict[str, Any]] = Field(default_factory=list)


class AssetTagOut(Contract):
    id: UUID
    tag_id: UUID
    canonical_key: str
    display_name: str
    category: str
    origin: str
    confidence: float | None
    model_version: str
    user_status: str
    review_status: str
    is_sensitive: bool


class AssetOut(Contract):
    id: UUID
    library_id: UUID
    source_asset_key: str
    media_type: str
    filename: str
    captured_at: datetime | None
    added_at: datetime | None
    width: int | None
    height: int | None
    duration: float | None
    filesize: int | None
    content_revision: str
    representation_revision: str
    ingestion_status: str
    classification_status: str
    visibility_status: str
    quality: dict[str, Any]
    last_error: str | None
    created_at: datetime
    thumbnail_url: str | None = None
    ranking: dict[str, Any] | None = None


class AssetDetailOut(AssetOut):
    metadata: dict[str, Any] | None
    resources: list[ResourceOut]
    tags: list[AssetTagOut]
    inference_runs: list[dict[str, Any]]
    mapping_status: str


class TagEdit(Contract):
    add: list[str] = Field(default_factory=list, max_length=100)
    remove: list[str] = Field(default_factory=list, max_length=100)
    approve: list[UUID] = Field(default_factory=list, max_length=100)
    reject: list[UUID] = Field(default_factory=list, max_length=100)


class BulkTagEdit(TagEdit):
    asset_ids: list[UUID] = Field(min_length=1, max_length=500)


class TagCreate(Contract):
    canonical_key: str = Field(min_length=1, max_length=255, pattern=r"^[\w\-]+$")
    display_name: str = Field(min_length=1, max_length=255)
    category: str = Field(default="other", max_length=64)
    is_sensitive: bool = False
    sync_eligible: bool = False


class AliasInput(Contract):
    alias: str = Field(min_length=1, max_length=255)
    language: str = Field(default="pt-BR", max_length=16)
    alias_type: str = Field(default="display", max_length=32)


class TagPatch(Contract):
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    category: str | None = Field(default=None, max_length=64)
    subcategory: str | None = Field(default=None, max_length=64)
    description: str | None = Field(default=None, max_length=2000)
    enabled: bool | None = None
    minimum_confidence: float | None = Field(default=None, ge=0, le=1)
    is_sensitive: bool | None = None
    sync_eligible: bool | None = None
    parent_id: UUID | None = None
    merged_into_id: UUID | None = None
    aliases: list[AliasInput] | None = Field(default=None, max_length=50)

    @model_validator(mode="after")
    def required_fields_cannot_be_cleared(self) -> "TagPatch":
        for key in self.model_fields_set & {
            "display_name", "category", "enabled", "minimum_confidence",
            "is_sensitive", "sync_eligible",
        }:
            if getattr(self, key) is None:
                raise ValueError(f"{key} cannot be null")
        return self


class FilterNode(Contract):
    op: Literal[
        "and", "or", "not", "tag", "text", "date", "number", "media_type",
        "source", "album", "duplicate", "quality", "screenshots",
    ]
    children: list["FilterNode"] = Field(default_factory=list, max_length=30)
    key: str | None = Field(default=None, max_length=64)
    value: str | float | bool | None = None
    comparison: Literal["eq", "ne", "lt", "lte", "gt", "gte"] = "gte"
    minimum: float | str | None = None
    maximum: float | str | None = None
    confidence: float = Field(default=0, ge=0, le=1)
    origin: Literal["apple", "joytag", "user", "import", "external"] | None = None

    @model_validator(mode="after")
    def structure(self) -> "FilterNode":
        if self.op in {"and", "or", "not"}:
            if not self.children or (self.op == "not" and len(self.children) != 1):
                raise ValueError("Boolean groups need children; NOT needs one child")
        elif self.children:
            raise ValueError("Leaf filters cannot contain children")
        if self.op in {"tag", "text", "media_type", "source", "album"}:
            if not isinstance(self.value, str) or not self.value or len(self.value) > 500:
                raise ValueError("Filter needs a bounded string value")
        if self.op == "number" and self.key not in {
            "width", "height", "filesize", "duration",
        }:
            raise ValueError("Invalid numeric field")
        if self.op == "date" and self.key not in {"captured_at", "added_at", "created_at"}:
            raise ValueError("Invalid date field")
        if self.op == "quality" and self.key not in {
            "sharpness", "brightness", "contrast", "resolution", "score",
        }:
            raise ValueError("Invalid quality field")
        if self.op in {"number", "quality"} and self.value is None:
            if self.minimum is None and self.maximum is None:
                raise ValueError("Numeric filters need a value or range")
        if self.op == "date" and self.minimum is None and self.maximum is None:
            raise ValueError("Date filters need a range")
        return self


class SearchRequest(Contract):
    query: str | None = Field(default=None, min_length=1, max_length=1000)
    filter: FilterNode | None = None
    sort: Literal[
        "captured_desc", "added_desc", "relevance", "quality_desc", "filesize_asc",
    ] = "captured_desc"
    limit: int = Field(default=60, ge=1, le=200)
    cursor: str | None = Field(default=None, max_length=4096)
    source_asset_id: UUID | None = None
    minimum_similarity: float = Field(default=0, ge=-1, le=1)

    @model_validator(mode="after")
    def bounded_tree(self) -> "SearchRequest":
        if self.query and self.source_asset_id:
            raise ValueError("Choose text or image semantic search")
        if self.filter:
            stack = [(self.filter, 0)]
            count = 0
            while stack:
                node, depth = stack.pop()
                count += 1
                if depth > 8 or count > 100:
                    raise ValueError("Filter tree exceeds resource limits")
                stack.extend((child, depth + 1) for child in node.children)
        return self


class SearchPage(Page[AssetOut]):
    explanation: dict[str, Any]


class SimilarRequest(Contract):
    asset_id: UUID
    filter: FilterNode | None = None
    limit: int = Field(default=30, ge=1, le=100)


class AlbumCreate(Contract):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)


class AlbumPatch(Contract):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    cover_asset_id: UUID | None = None
    sort_order: Literal["captured_desc", "added_desc", "position"] | None = None

    @model_validator(mode="after")
    def required_fields_cannot_be_cleared(self) -> "AlbumPatch":
        if ("name" in self.model_fields_set and self.name is None) or (
            "sort_order" in self.model_fields_set and self.sort_order is None
        ):
            raise ValueError("Album name and sort order cannot be null")
        return self


class AlbumAssetsInput(Contract):
    asset_ids: list[UUID] = Field(min_length=1, max_length=500)


class AlbumOut(Contract):
    id: UUID
    name: str
    description: str | None
    cover_asset_id: UUID | None
    sort_order: str
    asset_count: int = 0
    cover_url: str | None = None
    created_at: datetime
    updated_at: datetime


class SavedSearchInput(Contract):
    name: str = Field(min_length=1, max_length=255)
    query: SearchRequest


class JobOut(Contract):
    id: UUID
    job_type: str
    asset_id: UUID | None
    batch_id: UUID | None
    priority: int
    status: str
    attempts: int
    maximum_attempts: int
    scheduled_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    heartbeat_at: datetime | None
    lease_until: datetime | None
    worker_id: str | None
    progress: dict[str, Any]
    error_code: str | None
    error_details: dict[str, Any] | None
    created_at: datetime


ReindexJobType = Literal[
    "joytag_inference", "embedding_inference", "duplicate_analysis",
    "quality_analysis", "thumbnail_generate",
]


def default_reindex_types() -> list[ReindexJobType]:
    return ["joytag_inference", "embedding_inference"]


class ReindexInput(Contract):
    asset_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    job_types: list[ReindexJobType] = Field(default_factory=default_reindex_types)
    limit: int = Field(default=100, ge=1, le=10000)
    confirm_large_batch: bool = False


class IngestionInput(Contract):
    source: Literal["icloud", "fixture"] = "icloud"
    limit: int = Field(default=100, ge=1, le=10000)
    library_id: UUID | None = None
    full_scan: bool = False
    confirm_expansion: bool = False


class CategoryRule(Contract):
    enabled: bool = True
    minimum_confidence: float = Field(default=.4, ge=0, le=1)


class TaxonomyOverride(Contract):
    category: Literal[
        "person", "body", "face_hair", "clothing", "clothing_bulge", "pose_action",
        "sexual_action", "genitals", "penis", "environment", "objects", "composition",
        "visual", "other",
    ] | None = None
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    is_sensitive: bool | None = None
    aliases: list[str] = Field(default_factory=list, max_length=30)
    parent_key: str | None = Field(default=None, max_length=255)


class CompoundRule(Contract):
    all: list[str] = Field(min_length=1, max_length=30)
    none: list[str] = Field(default_factory=list, max_length=30)
    output: str = Field(min_length=1, max_length=255)


class RethresholdInput(Contract):
    asset_ids: list[UUID] = Field(min_length=1, max_length=1000)


class SettingsPatch(Contract):
    sensitive_tags_visible: bool | None = None
    gpu_enabled: bool | None = None
    batch_size: int | None = Field(default=None, ge=1, le=128)
    worker_concurrency: int | None = Field(default=None, ge=1, le=32)
    joytag_threshold: float | None = Field(default=None, ge=0, le=1)
    joytag_max_tags: int | None = Field(default=None, ge=1, le=1000)
    ingestion_interval_minutes: int | None = Field(default=None, ge=5, le=10080)
    ingestion_import_limit: int | None = Field(default=None, ge=1, le=1000000)
    max_download_bytes: int | None = Field(default=None, ge=1024, le=1024**3)
    max_run_download_bytes: int | None = Field(default=None, ge=1024, le=1024**4)
    max_gpu_concurrency: int | None = Field(default=None, ge=1, le=16)
    gpu_max_assets_per_run: int | None = Field(default=None, ge=1, le=100000)
    gpu_max_cost_per_run: float | None = Field(default=None, ge=0, le=1000)
    gpu_daily_budget: float | None = Field(default=None, ge=0, le=1000)
    gpu_monthly_budget: float | None = Field(default=None, ge=0, le=10000)
    temporary_retention_hours: int | None = Field(default=None, ge=1, le=8760)
    apple_keyword_sync_mode: Literal["manual", "disabled"] | None = None
    taxonomy_categories: dict[str, CategoryRule] | None = Field(default=None, max_length=14)
    taxonomy_overrides: dict[str, TaxonomyOverride] | None = Field(default=None, max_length=1000)
    taxonomy_compound_rules: list[CompoundRule] | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def taxonomy_keys(self) -> "SettingsPatch":
        categories = {
            "person", "body", "face_hair", "clothing", "clothing_bulge", "pose_action",
            "sexual_action", "genitals", "penis", "environment", "objects", "composition",
            "visual", "other",
        }
        if self.taxonomy_categories and set(self.taxonomy_categories) - categories:
            raise ValueError("Unknown taxonomy category")
        for key, override in (self.taxonomy_overrides or {}).items():
            if not 1 <= len(key) <= 255:
                raise ValueError("Invalid taxonomy key")
            if any(not 1 <= len(alias) <= 255 for alias in override.aliases):
                raise ValueError("Invalid taxonomy alias")
        for rule in self.taxonomy_compound_rules or []:
            if any(not 1 <= len(key) <= 255 for key in [*rule.all, *rule.none]):
                raise ValueError("Invalid compound-rule key")
        return self
