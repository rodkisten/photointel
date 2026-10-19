#!/usr/bin/env python3
"""Representative synthetic catalog in a NEW, disposable local PostgreSQL database.

Never targets an existing application database. Creation/destruction requires the
literal opt-in SYNTHETIC_ONLY and a local admin connection supplied through env.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import re
import resource
import shutil
import signal
import socket
import statistics
import subprocess
import tempfile
import threading
import time
from collections import Counter
from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import httpx
import numpy as np
import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[2]
SIZES = (1000, 10000, 100000, 176000)
PREPROCESSING_REVISION = "siglip2-transformers-5.10.2-v2"


class ServerMonitor:
    """Sample only a named local container; never infer Cloud Run utilization."""

    def __init__(self, container: str | None, database_url: str) -> None:
        self.container = container
        self.database_url = database_url
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.samples: list[dict[str, Any]] = []
        self.connection_samples: list[int] = []

    def start(self) -> None:
        self.thread = threading.Thread(target=self._sample, daemon=True)
        self.thread.start()

    def _sample(self) -> None:
        while not self.stop_event.is_set():
            try:
                with psycopg.connect(self.database_url, autocommit=True) as connection:
                    self.connection_samples.append(
                        first_value(
                            connection.execute(
                                "SELECT count(*) FROM pg_stat_activity "
                                "WHERE datname=current_database()"
                            )
                        )
                    )
                if self.container:
                    observed = subprocess.run(
                        [
                            "docker",
                            "stats",
                            "--no-stream",
                            "--format",
                            "{{json .}}",
                            self.container,
                        ],
                        check=True,
                        capture_output=True,
                        text=True,
                        timeout=8,
                    )
                    sample = json.loads(observed.stdout)
                    self.samples.append(
                        {
                            "elapsed_monotonic": time.monotonic(),
                            "cpu_percent": float(sample["CPUPerc"].rstrip("%")),
                            "memory_usage": sample["MemUsage"],
                            "memory_percent": float(sample["MemPerc"].rstrip("%")),
                        }
                    )
            except (psycopg.Error, subprocess.SubprocessError, ValueError, KeyError):
                # Monitoring cannot alter workload success. Missing samples are
                # visible in the report and never replaced with invented values.
                pass
            self.stop_event.wait(2)

    def finish(self) -> dict[str, Any]:
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=10)
        return {
            "container": self.container,
            "scope": "shared local PostgreSQL container, includes other databases",
            "sample_interval_seconds": 2,
            "peak_database_connections_observed": max(self.connection_samples)
            if self.connection_samples
            else None,
            "connection_observer_included": True,
            "container_samples": self.samples,
            "server_cpu_memory_measured": bool(self.samples),
            "cloud_run_execution_measured": False,
        }


def terminate_gracefully(_signum: int, _frame: Any) -> None:
    """Allow finally to drop only this process's disposable database on SIGTERM."""
    raise KeyboardInterrupt("Benchmark interrupted")


def validate_container(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value):
        raise argparse.ArgumentTypeError("Expected a local container name")
    return value


def first_value(cursor: psycopg.Cursor[Any]) -> Any:
    row = cursor.fetchone()
    if row is None:
        raise RuntimeError("Expected a row from benchmark query")
    return row[0]


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(report, indent=2, default=str) + "\n")
    partial.replace(path)


def storage_preflight(
    count: int, tags_per_asset: int, free_bytes: int, minimum_free_gib: int
) -> dict[str, Any]:
    # Conservative shape estimate, calibrated from the measured 30-tag fixture.
    # This is not a PostgreSQL/Neon quota probe or a hard disk reservation.
    estimated_bytes_per_asset = 11000 + 700 * tags_per_asset
    estimated_fixture_bytes = count * estimated_bytes_per_asset
    reserved_bytes = minimum_free_gib * 1024**3
    return {
        "allowed": free_bytes >= estimated_fixture_bytes + reserved_bytes,
        "local_free_bytes_observed": free_bytes,
        "estimated_fixture_bytes": estimated_fixture_bytes,
        "estimated_bytes_per_asset": estimated_bytes_per_asset,
        "minimum_free_bytes_after_fixture": reserved_bytes,
        "provider_quota_measured": False,
        "estimate_is_measurement": False,
        "limitation": (
            "Local workspace filesystem only; verify PostgreSQL's actual data volume "
            "separately. Concurrent builds can consume space after this check."
        ),
    }


def validate_target(url: str, confirmation: str, count: int) -> None:
    parsed = urlsplit(url)
    if confirmation != "SYNTHETIC_ONLY" or count not in SIZES:
        raise ValueError("Explicit SYNTHETIC_ONLY and a supported asset count required")
    if os.environ.get("APP_ENV") == "production":
        raise ValueError("Benchmarks are forbidden in APP_ENV=production")
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1", "postgres"}:
        raise ValueError("Capacity benchmarks require a disposable LOCAL PostgreSQL")
    if "neon.tech" in url or "pooler" in url:
        raise ValueError("Never benchmark against a Neon/pooled production endpoint")


def database_url(admin_url: str, name: str) -> str:
    parsed = urlsplit(admin_url)
    return urlunsplit(parsed._replace(path="/" + name, query="", fragment=""))


def percentile(values: list[float], percentile_value: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile_value
    low = math.floor(position)
    high = math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def metrics(values: list[float]) -> dict[str, Any]:
    return {
        "samples": len(values),
        "p50_ms": statistics.median(values),
        "p95_ms": percentile(values, 0.95),
        "p99_ms": percentile(values, 0.99) if len(values) >= 100 else None,
        "minimum_ms": min(values),
        "maximum_ms": max(values),
    }


def copy_rows(
    connection: psycopg.Connection[Any], table: str, columns: list[str], rows: Any
) -> None:
    command = sql.SQL("COPY {} ({}) FROM STDIN").format(
        sql.Identifier(table), sql.SQL(",").join(map(sql.Identifier, columns))
    )
    with connection.cursor().copy(command) as writer:
        for row in rows:
            writer.write_row(row)


def populate(
    connection: psycopg.Connection[Any], count: int, tags_per_asset: int
) -> dict[str, Any]:
    now = datetime.now(UTC)
    library, model, album = uuid4(), uuid4(), uuid4()
    assets = [uuid4() for _ in range(count)]
    tags = [uuid4() for _ in range(1000)]
    copy_rows(
        connection,
        "libraries",
        ["id", "source_type", "source_identifier", "name", "configuration"],
        [(library, "benchmark", "disposable-v11", "Synthetic only", "{}")],
    )
    copy_rows(
        connection,
        "model_registry",
        [
            "id",
            "provider",
            "model_name",
            "revision",
            "preprocessing_revision",
            "architecture",
            "embedding_dimension",
            "parameters",
            "capabilities",
            "active",
        ],
        [
            (
                model,
                "synthetic",
                "synthetic/siglip-shape-only",
                "0" * 40,
                PREPROCESSING_REVISION,
                "synthetic-vector768",
                768,
                "{}",
                "[]",
                False,
            )
        ],
    )
    started = time.perf_counter()
    # Build HNSW separately to measure index build time and storage explicitly.
    connection.execute("DROP INDEX ix_embeddings_cosine_hnsw")
    for offset in range(0, count, 1000):
        stop = min(count, offset + 1000)
        copy_rows(
            connection,
            "assets",
            [
                "id",
                "library_id",
                "source_asset_key",
                "source_metadata",
                "media_type",
                "filename",
                "captured_at",
                "added_at",
                "width",
                "height",
                "filesize",
                "content_revision",
                "representation_revision",
                "ingestion_status",
                "classification_status",
                "visibility_status",
                "missing_scan_count",
                "quality",
            ],
            (
                (
                    asset,
                    library,
                    f"synthetic-{index}",
                    '{"is_screenshot":false}',
                    "image",
                    f"synthetic-garden-{index}.jpg",
                    now - timedelta(days=index % 3650),
                    now,
                    4032,
                    3024,
                    1500000 + index % 2000000,
                    "r2",
                    "medium-r2",
                    "completed",
                    "completed",
                    "active",
                    0,
                    json.dumps({"score": (index % 100) / 100, "brightness": 0.5}),
                )
                for index, asset in enumerate(assets[offset:stop], start=offset)
            ),
        )
        copy_rows(
            connection,
            "asset_metadata",
            ["asset_id", "camera", "lens", "original_filename", "additional_metadata"],
            (
                (
                    asset,
                    "Synthetic Camera",
                    "26mm",
                    f"fixture-{index}.jpg",
                    '{"fixture":true,"orientation":1}',
                )
                for index, asset in enumerate(assets[offset:stop], start=offset)
            ),
        )
        copy_rows(
            connection,
            "asset_resources",
            [
                "id",
                "asset_id",
                "resource_type",
                "object_key",
                "mime_type",
                "byte_size",
                "width",
                "height",
                "sha256",
                "revision",
                "status",
                "created_at",
            ],
            (
                (
                    uuid4(),
                    asset,
                    variant,
                    f"synthetic/{asset}/{variant}.webp",
                    "image/webp",
                    size,
                    width,
                    height,
                    hashlib.sha256(str(asset).encode()).hexdigest(),
                    "medium-r2",
                    "available",
                    now,
                )
                for asset in assets[offset:stop]
                for variant, size, width, height in (
                    ("thumbnail_small", 12000, 240, 180),
                    ("thumbnail_medium", 65000, 640, 480),
                    ("preview_large", 260000, 1600, 1200),
                )
            ),
        )
        copy_rows(
            connection,
            "jobs",
            [
                "id",
                "job_type",
                "asset_id",
                "payload",
                "priority",
                "status",
                "attempts",
                "maximum_attempts",
                "scheduled_at",
                "finished_at",
                "progress",
                "idempotency_key",
                "created_at",
            ],
            (
                (
                    uuid4(),
                    "thumbnail_generate",
                    asset,
                    "{}",
                    0,
                    "completed",
                    1,
                    3,
                    now,
                    now,
                    '{"completed":1}',
                    f"synthetic:{asset}:r2",
                    now,
                )
                for asset in assets[offset:stop]
            ),
        )
        connection.commit()
    asset_seconds = time.perf_counter() - started
    copy_rows(
        connection,
        "tags",
        [
            "id",
            "canonical_key",
            "display_name",
            "category",
            "description",
            "is_sensitive",
            "created_at",
            "minimum_confidence",
            "enabled",
            "sync_eligible",
        ],
        (
            (
                tag,
                f"synthetic_tag_{index}",
                f"Synthetic tag {index}",
                "objects",
                "Synthetic capacity vocabulary",
                False,
                now,
                0.4,
                True,
                False,
            )
            for index, tag in enumerate(tags)
        ),
    )
    started = time.perf_counter()
    for offset in range(0, count, 1000):
        copy_rows(
            connection,
            "asset_tags",
            [
                "id",
                "asset_id",
                "tag_id",
                "origin",
                "confidence",
                "model_version",
                "user_status",
                "review_status",
                "created_at",
                "updated_at",
            ],
            (
                (
                    uuid4(),
                    asset,
                    tags[(index * 17 + tag_index) % len(tags)],
                    "joytag",
                    0.4 + tag_index / (2 * tags_per_asset),
                    "0" * 40,
                    "approved",
                    "unreviewed",
                    now,
                    now,
                )
                for index, asset in enumerate(
                    assets[offset : offset + 1000], start=offset
                )
                for tag_index in range(tags_per_asset)
            ),
        )
        connection.commit()
    tag_seconds = time.perf_counter() - started
    started = time.perf_counter()
    random = np.random.default_rng(20261018)
    first_vector = ""
    for offset in range(0, count, 250):
        ids = assets[offset : offset + 250]
        vectors = random.normal(size=(len(ids), 768)).astype(np.float32)
        vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
        rows = []
        for asset, vector in zip(ids, vectors, strict=True):
            encoded = (
                "[" + ",".join(format(float(value), ".7g") for value in vector) + "]"
            )
            if not first_vector:
                first_vector = encoded
            rows.append((uuid4(), asset, model, "medium-r2", encoded, now))
        copy_rows(
            connection,
            "embeddings",
            ["id", "asset_id", "model_id", "input_revision", "vector", "created_at"],
            rows,
        )
        connection.commit()
    vector_seconds = time.perf_counter() - started
    # Full raw JoyTag vocabulary is deliberately sampled at 1%, then separately
    # projected. Pretending that tens of accepted tags represent all retained
    # probabilities would radically underestimate the production database.
    raw_before = first_value(
        connection.execute("SELECT pg_total_relation_size('inference_runs')")
    )
    vocabulary_size = 5813
    raw_count = max(1, count // 100)
    score_random = np.random.default_rng(20261019)
    copy_rows(
        connection,
        "inference_runs",
        [
            "id",
            "asset_id",
            "model_id",
            "input_revision",
            "status",
            "runtime_ms",
            "raw_predictions",
            "completed_at",
            "created_at",
        ],
        (
            (
                uuid4(),
                asset,
                model,
                "medium-r2",
                "completed",
                1000,
                json.dumps(
                    {
                        "probabilities": {
                            f"synthetic_vocabulary_{index}": float(value)
                            for index, value in enumerate(
                                score_random.random(vocabulary_size)
                            )
                        }
                    },
                    separators=(",", ":"),
                ),
                now,
                now,
            )
            for asset in assets[:raw_count]
        ),
    )
    connection.commit()
    raw_after = first_value(
        connection.execute("SELECT pg_total_relation_size('inference_runs')")
    )
    raw_sampling = {
        "assets_with_full_raw_predictions": raw_count,
        "vocabulary_size": vocabulary_size,
        "sample_fraction": raw_count / count,
        "measured_table_growth_bytes": raw_after - raw_before,
        "measured_bytes_per_sample": (raw_after - raw_before) / raw_count,
        "additional_full_retention_projection_bytes": (count - raw_count)
        * (raw_after - raw_before)
        / raw_count,
        "projection_is_measurement": False,
        "warning": (
            "Core catalog is a LOWER BOUND; full raw retention is projected separately"
        ),
    }
    started = time.perf_counter()
    connection.execute(
        "CREATE INDEX ix_embeddings_cosine_hnsw ON embeddings "
        "USING hnsw (vector vector_cosine_ops) WITH (m=16,ef_construction=64)"
    )
    connection.commit()
    hnsw_seconds = time.perf_counter() - started
    copy_rows(
        connection,
        "albums",
        ["id", "name", "description", "sort_order"],
        [(album, "Synthetic saved album", "Capacity fixture", "captured_desc")],
    )
    copy_rows(
        connection,
        "album_assets",
        ["album_id", "asset_id", "position", "added_at"],
        ((album, asset, index, now) for index, asset in enumerate(assets[::20])),
    )
    copy_rows(
        connection,
        "metadata_snapshots",
        ["id", "asset_id", "source", "revision_hash", "payload", "created_at"],
        (
            (uuid4(), asset, "benchmark", "old-revision", '{"fixture":true}', now)
            for asset in assets[::10]
        ),
    )
    for offset in range(0, min(count, 1000), 10):
        group = uuid4()
        copy_rows(
            connection,
            "duplicate_groups",
            ["id", "duplicate_type", "group_key", "algorithm", "created_at"],
            [(group, "near", f"synthetic-{group}", "phash", now)],
        )
        copy_rows(
            connection,
            "duplicate_members",
            ["group_id", "asset_id", "similarity", "quality_rank"],
            (
                (group, asset, 0.95, index)
                for index, asset in enumerate(assets[offset : offset + 2])
            ),
        )
    copy_rows(
        connection,
        "query_embedding_cache",
        [
            "cache_key",
            "model_id",
            "model_revision",
            "preprocessing_revision",
            "vector",
            "status",
            "expires_at",
        ],
        (
            (
                hashlib.sha256(f"synthetic-query-{index}".encode()).hexdigest(),
                model,
                "0" * 40,
                PREPROCESSING_REVISION,
                first_vector,
                "ready",
                now + timedelta(days=1),
            )
            for index in range(min(count, 1000))
        ),
    )
    connection.commit()
    connection.execute(
        "UPDATE jobs SET status='queued',finished_at=NULL "
        "WHERE asset_id IN (SELECT id FROM assets LIMIT 1000)"
    )
    connection.execute("ANALYZE")
    connection.commit()
    return {
        "library_id": str(library),
        "model_id": str(model),
        "album_id": str(album),
        "query_vector": first_vector,
        "asset_insert_seconds": asset_seconds,
        "tag_insert_seconds": tag_seconds,
        "vector_insert_seconds": vector_seconds,
        "hnsw_build_seconds": hnsw_seconds,
        "assets_per_second": count / asset_seconds,
        "tag_associations_per_second": count * tags_per_asset / tag_seconds,
        "vectors_per_second": count / vector_seconds,
        "raw_predictions_sampling": raw_sampling,
    }


def storage(connection: psycopg.Connection[Any], count: int) -> dict[str, Any]:
    rows = connection.execute("""
        SELECT relname AS table_name, n_live_tup AS estimated_rows,
          pg_relation_size(relid) AS heap_bytes,
          pg_indexes_size(relid) AS indexes_bytes,
          pg_total_relation_size(relid) AS total_bytes
        FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC
    """).fetchall()
    result = [
        dict(
            zip(
                ("table", "estimated_rows", "heap_bytes", "indexes_bytes", "total_bytes"),
                row,
                strict=True,
            )
        )
        for row in rows
    ]
    for row in result:
        table = row["table"]
        row["exact_rows"] = first_value(
            connection.execute(
                sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))
            )
        )
    total = first_value(connection.execute("SELECT pg_database_size(current_database())"))
    embedding = next(row for row in result if row["table"] == "embeddings")
    tags = next(row for row in result if row["table"] == "asset_tags")
    return {
        "database_bytes": total,
        "average_database_bytes_per_asset": total / count,
        "average_embedding_total_bytes": embedding["total_bytes"] / count,
        "average_tags_per_asset": tags["exact_rows"] / count,
        "tables": result,
    }


def queries(seed: dict[str, Any]) -> dict[str, tuple[str, tuple[Any, ...]]]:
    return {
        "gallery": (
            "SELECT id,filename,captured_at FROM assets WHERE visibility_status='active' "
            "ORDER BY captured_at DESC,id LIMIT 60",
            (),
        ),
        "metadata_filters": (
            "SELECT id FROM assets WHERE width>=3000 AND filesize<2000000 "
            "AND captured_at<now()-interval '365 days' "
            "ORDER BY captured_at DESC,id LIMIT 60",
            (),
        ),
        "tag_filter": (
            "SELECT a.id FROM assets a WHERE EXISTS (SELECT 1 FROM asset_tags t "
            "JOIN tags v ON v.id=t.tag_id WHERE t.asset_id=a.id AND "
            "v.canonical_key='synthetic_tag_17' AND t.confidence>=0.4) "
            "ORDER BY a.captured_at DESC LIMIT 60",
            (),
        ),
        "facets": (
            "SELECT t.tag_id,count(*) FROM asset_tags t JOIN assets a ON a.id=t.asset_id "
            "WHERE a.filesize<1700000 GROUP BY t.tag_id ORDER BY count(*) DESC LIMIT 30",
            (),
        ),
        "album": (
            "SELECT a.id FROM album_assets aa JOIN assets a ON a.id=aa.asset_id "
            "WHERE aa.album_id=%s ORDER BY aa.position LIMIT 60",
            (seed["album_id"],),
        ),
        "semantic_ann": (
            "SELECT asset_id FROM embeddings ORDER BY vector <=> %s::vector LIMIT 20",
            (seed["query_vector"],),
        ),
        "hybrid": (
            "SELECT e.asset_id FROM embeddings e JOIN assets a ON a.id=e.asset_id "
            "WHERE a.filesize<1700000 AND a.width>=3000 "
            "ORDER BY e.vector <=> %s::vector LIMIT 20",
            (seed["query_vector"],),
        ),
        "jobs_claim": (
            "WITH candidate AS (SELECT id FROM jobs "
            "WHERE status IN ('queued','retrying') AND scheduled_at<=now() "
            "ORDER BY priority DESC,scheduled_at,created_at "
            "LIMIT 1 FOR UPDATE SKIP LOCKED) "
            "UPDATE jobs j SET status='running',worker_id='synthetic-capacity', "
            "fence_token=fence_token+1,heartbeat_at=now(), "
            "lease_until=now()+interval '120 seconds' FROM candidate "
            "WHERE j.id=candidate.id RETURNING j.id",
            (),
        ),
    }


def run_query(url: str, command: str, parameters: tuple[Any, ...]) -> float:
    # One connection per operation reproduces cold request acquisition for a
    # NullPool-style client; includes client connection cost explicitly.
    started = time.perf_counter()
    with psycopg.connect(url, autocommit=True) as connection:
        connection.execute("SET statement_timeout='60s'")
        connection.execute(command, parameters).fetchall()
    return (time.perf_counter() - started) * 1000


def search_benchmark(
    url: str, connection: psycopg.Connection[Any], seed: dict[str, Any], samples: int
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, (command, parameters) in queries(seed).items():
        observed = run_query(url, command, parameters)
        plan = first_value(
            connection.execute(
                "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + command, parameters
            )
        )
        values = [run_query(url, command, parameters) for _ in range(samples)]
        result[name] = {
            "first_observed_ms": observed,
            "cold_cache_claim": False,
            "warm": metrics(values),
            "plan": plan,
            "includes_connection_acquisition": True,
        }
        if name in {"semantic_ann", "hybrid", "facets", "jobs_claim"}:
            result[name]["concurrent"] = {}
            for concurrency in (1, 5, 20):
                started = time.perf_counter()
                with concurrent.futures.ThreadPoolExecutor(
                    max_workers=concurrency
                ) as pool:
                    futures = [
                        pool.submit(run_query, url, command, parameters)
                        for _ in range(max(samples, concurrency * 5))
                    ]
                    durations = [future.result() for future in futures]
                elapsed = time.perf_counter() - started
                result[name]["concurrent"][str(concurrency)] = {
                    **metrics(durations),
                    "queries_per_second": len(durations) / elapsed,
                    "total_seconds": elapsed,
                }
    return result


def halfvec_evaluation(
    connection: psycopg.Connection[Any], seed: dict[str, Any]
) -> dict[str, Any]:
    query = seed["query_vector"]
    connection.execute("SET LOCAL enable_indexscan=off")
    full = [
        row[0]
        for row in connection.execute(
            "SELECT asset_id FROM embeddings ORDER BY vector <=> %s::vector LIMIT 20",
            (query,),
        )
    ]
    half = [
        row[0]
        for row in connection.execute(
            "SELECT asset_id FROM embeddings "
            "ORDER BY vector::halfvec(768) <=> %s::halfvec(768) "
            "LIMIT 20",
            (query,),
        )
    ]
    connection.commit()
    # Expression index is experimental and removed after measuring. Application
    # vectors remain full precision; no automatic production schema change.
    started = time.perf_counter()
    connection.execute(
        "CREATE INDEX capacity_halfvec_hnsw ON embeddings USING hnsw "
        "((vector::halfvec(768)) halfvec_cosine_ops)"
    )
    connection.commit()
    elapsed = time.perf_counter() - started
    index_bytes = first_value(
        connection.execute("SELECT pg_relation_size('capacity_halfvec_hnsw')")
    )
    connection.execute("SET hnsw.ef_search=100")
    approximate = [
        row[0]
        for row in connection.execute(
            "SELECT asset_id FROM embeddings "
            "ORDER BY vector::halfvec(768) <=> %s::halfvec(768) "
            "LIMIT 20",
            (query,),
        )
    ]
    result = {
        "queries_evaluated": 1,
        "synthetic_only": True,
        "exact_halfvec_overlap_at_20": len(set(full) & set(half)) / len(full),
        "approximate_halfvec_recall_at_20": len(set(full) & set(approximate)) / len(full),
        "halfvec_expression_index_bytes": index_bytes,
        "halfvec_index_build_seconds": elapsed,
        "production_precision_changed": False,
        "limitation": (
            "One synthetic query is insufficient to approve a precision migration"
        ),
    }
    connection.execute("DROP INDEX capacity_halfvec_hnsw")
    connection.commit()
    return result


def api_benchmark(
    url: str, connection: psycopg.Connection[Any], seed: dict[str, Any], samples: int
) -> dict[str, Any]:
    """Real local HTTP API on the synthetic disposable catalog, never cloud."""
    connection.execute(
        "UPDATE model_registry SET active=true WHERE id=%s", (seed["model_id"],)
    )
    source_id = first_value(connection.execute("SELECT asset_id FROM embeddings LIMIT 1"))
    connection.commit()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    environment = dict(
        os.environ,
        DATABASE_URL=url.replace("postgresql://", "postgresql+asyncpg://"),
        APP_ENV="test",
        AUTH_MODE="local",
        EXECUTION_PLATFORM="vps",
        DATABASE_REQUIRE_TLS="false",
        DATABASE_POOL_MODE="direct",
        DATABASE_POOL_SIZE="2",
        DATABASE_MAX_OVERFLOW="0",
        ICLOUD_ENABLED="false",
        GPU_ENABLED="false",
        STORAGE_BACKEND="local",
        SIGLIP_MODEL_ID="synthetic/siglip-shape-only",
        SIGLIP_MODEL_REVISION="0" * 40,
        QUERY_PREPROCESSING_REVISION=PREPROCESSING_REVISION,
        DATABASE_PROFILE="full",
        CATALOG_ASSET_LIMIT="500000",
    )
    with tempfile.TemporaryDirectory(prefix="photointel-capacity-api-") as local_media:
        environment["STORAGE_LOCAL_DIRECTORY"] = local_media
        process = subprocess.Popen(
            [
                str(ROOT / ".venv/bin/uvicorn"),
                "photointel.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--no-proxy-headers",
            ],
            cwd=ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            with (
                httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=60) as client,
                ExitStack() as request_clients,
            ):
                deadline = time.monotonic() + 30
                while True:
                    try:
                        response = client.get("/health/live")
                        if response.status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError("Local synthetic API did not become healthy")
                    time.sleep(0.1)
                result: dict[str, Any] = {
                    "local_http": True,
                    "cloud_run": False,
                    "database_pool_size": 2,
                    "max_overflow": 0,
                    "synthetic_catalog_only": True,
                    "rate_limit_enabled": True,
                    "endpoint_buckets_isolated_by_real_loopback_source_ip": True,
                    "identity_or_proxy_headers_forged": False,
                    "queries": {},
                }
                requests = {
                    "gallery": ("GET", "/v1/assets?limit=60", None),
                    "metadata_filters": (
                        "POST",
                        "/v1/search",
                        {
                            "filter": {"op": "number", "key": "width", "minimum": 3000},
                            "limit": 60,
                        },
                    ),
                    "similar_image": (
                        "POST",
                        "/v1/search",
                        {
                            "source_asset_id": str(source_id),
                            "limit": 20,
                        },
                    ),
                }
                # Measure one successful semantic request before sustained POST
                # load. The real per-IP limiter stays enabled and 429s are reported.
                requests = {"similar_image": requests.pop("similar_image"), **requests}
                for index, (name, (method, path, payload)) in enumerate(requests.items()):
                    request_client = request_clients.enter_context(
                        httpx.Client(
                            base_url=f"http://127.0.0.1:{port}",
                            timeout=60,
                            transport=httpx.HTTPTransport(
                                local_address=f"127.0.0.{index + 2}"
                            ),
                        )
                    )

                    def request(
                        method=method, path=path, payload=payload, client=request_client
                    ):
                        started = time.perf_counter()
                        try:
                            response = client.request(method, path, json=payload)
                            status = response.status_code
                        except httpx.TransportError:
                            # A timeout is a failed sample, not a successful
                            # query and not a reason to discard other metrics.
                            status = 0
                        return (
                            (time.perf_counter() - started) * 1000,
                            status,
                        )

                    observed = request()
                    if observed[1] != 200:
                        raise RuntimeError(
                            f"Synthetic API baseline returned HTTP {observed[1]}"
                        )
                    result["queries"][name] = {
                        "first_observed_ms": observed[0],
                        "first_observed_status": observed[1],
                        "cold_cache_claim": False,
                        "concurrent": {},
                    }
                    for concurrency in (1, 5, 20):
                        started = time.perf_counter()
                        with concurrent.futures.ThreadPoolExecutor(
                            max_workers=concurrency
                        ) as pool:
                            futures = [
                                pool.submit(request)
                                for _ in range(max(samples, concurrency * 5))
                            ]
                            values = [future.result() for future in futures]
                        elapsed = time.perf_counter() - started
                        result["queries"][name]["concurrent"][str(concurrency)] = {
                            "http_latency": metrics([value[0] for value in values]),
                            "successful_latency": metrics(
                                [value[0] for value in values if value[1] == 200]
                            )
                            if any(value[1] == 200 for value in values)
                            else None,
                            "status_counts": dict(Counter(value[1] for value in values)),
                            "failed_requests": sum(value[1] != 200 for value in values),
                            "requests_per_second": len(values) / elapsed,
                            "successful_requests_per_second": sum(
                                value[1] == 200 for value in values
                            )
                            / elapsed,
                        }
                process_status = Path(f"/proc/{process.pid}/status")
                result["api_process_peak_rss_kib"] = None
                if process_status.exists():
                    for line in process_status.read_text().splitlines():
                        if line.startswith("VmHWM:"):
                            result["api_process_peak_rss_kib"] = int(line.split()[1])
                return result
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=int, choices=SIZES, required=True)
    parser.add_argument("--tags-per-asset", type=int, default=30, choices=range(10, 81))
    parser.add_argument("--samples", type=int, default=30, choices=range(5, 201))
    parser.add_argument("--confirm-disposable", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--halfvec", action="store_true")
    parser.add_argument("--postgres-container", type=validate_container)
    parser.add_argument(
        "--parallel-workers-per-query", type=int, choices=(0, 1, 2), default=0
    )
    parser.add_argument(
        "--maintenance-work-mem-mib", type=int, choices=(64, 128, 256, 512), default=64
    )
    parser.add_argument(
        "--minimum-free-gib", type=int, choices=range(0, 129), default=5
    )
    arguments = parser.parse_args()
    signal.signal(signal.SIGTERM, terminate_gracefully)
    admin_url = os.environ.get("CAPACITY_ADMIN_DATABASE_URL", "")
    validate_target(admin_url, arguments.confirm_disposable, arguments.assets)
    name = "photointel_capacity_" + uuid4().hex[:20]
    target = database_url(admin_url, name)
    report: dict[str, Any] = {
        "schema_version": 1,
        "status": "running",
        "synthetic_only": True,
        "real_model_inference": False,
        "real_cloud_resources": False,
        "git_sha": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip(),
        "source_file_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "working_tree_dirty": bool(
            subprocess.check_output(
                ["git", "status", "--porcelain"], cwd=ROOT, text=True
            ).strip()
        ),
        "started_at": datetime.now(UTC).isoformat(),
        "asset_count": arguments.assets,
        "tags_per_asset": arguments.tags_per_asset,
        "embedding_dimension": 768,
        "preprocessing_revision": PREPROCESSING_REVISION,
        "disposable_database": name,
        "database_dropped": False,
        "database_created": False,
        "completed_stages": [],
        "parallel_workers_per_query": arguments.parallel_workers_per_query,
        "maintenance_work_mem_mib": arguments.maintenance_work_mem_mib,
        "parallel_maintenance_workers": 0,
        "parallelism_note": (
            "Default zero models a resource-limited database and prevents many "
            "concurrent parallel hashes exhausting Docker's default 64MiB /dev/shm. "
            "This setting applies only to the newly created disposable database."
        ),
    }
    report["storage_preflight"] = storage_preflight(
        arguments.assets,
        arguments.tags_per_asset,
        shutil.disk_usage(ROOT).free,
        arguments.minimum_free_gib,
    )
    if not report["storage_preflight"]["allowed"]:
        report["status"] = "not_run"
        report["blocked_reason"] = "insufficient_local_space_with_safety_reserve"
        write_report(arguments.output, report)
        print(json.dumps({"status": "not_run", "output": str(arguments.output)}))
        raise SystemExit(2)
    write_report(arguments.output, report)
    started = time.perf_counter()
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(
            sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name))
        )
        report["database_created"] = True
        admin.execute(
            sql.SQL("ALTER DATABASE {} SET max_parallel_workers_per_gather = {}").format(
                sql.Identifier(name), sql.Literal(arguments.parallel_workers_per_query)
            )
        )
        admin.execute(
            sql.SQL("ALTER DATABASE {} SET max_parallel_maintenance_workers = 0").format(
                sql.Identifier(name)
            )
        )
        admin.execute(
            sql.SQL("ALTER DATABASE {} SET maintenance_work_mem = {}").format(
                sql.Identifier(name),
                sql.Literal(f"{arguments.maintenance_work_mem_mib}MB"),
            )
        )
        monitor = ServerMonitor(arguments.postgres_container, target)
        monitor.start()
        try:
            environment = dict(
                os.environ,
                DATABASE_URL=target.replace("postgresql://", "postgresql+asyncpg://"),
                MIGRATION_DATABASE_URL=target.replace(
                    "postgresql://", "postgresql+asyncpg://"
                ),
                APP_ENV="test",
                DATABASE_POOL_MODE="direct",
                DATABASE_REQUIRE_TLS="false",
            )
            subprocess.run(
                [
                    str(ROOT / ".venv/bin/alembic"),
                    "-c",
                    "infra/migrations/alembic.ini",
                    "upgrade",
                    "head",
                ],
                cwd=ROOT,
                env=environment,
                check=True,
                timeout=180,
            )
            with psycopg.connect(target) as connection:
                report["postgresql"] = first_value(connection.execute("SELECT version()"))
                report["pgvector"] = first_value(
                    connection.execute(
                        "SELECT extversion FROM pg_extension WHERE extname='vector'"
                    )
                )
                report["migration_head"] = first_value(
                    connection.execute("SELECT version_num FROM alembic_version")
                )
                report["completed_stages"].append("migrations")
                seed = populate(connection, arguments.assets, arguments.tags_per_asset)
                report["population"] = {
                    key: value
                    for key, value in seed.items()
                    if key not in {"query_vector", "library_id", "model_id", "album_id"}
                }
                report["storage"] = storage(connection, arguments.assets)
                report["completed_stages"].append("population_and_storage")
                write_report(arguments.output, report)
                report["queries"] = search_benchmark(
                    target, connection, seed, arguments.samples
                )
                report["completed_stages"].append("sql_queries")
                write_report(arguments.output, report)
                report["local_api"] = api_benchmark(
                    target, connection, seed, arguments.samples
                )
                report["completed_stages"].append("local_api")
                write_report(arguments.output, report)
                if arguments.halfvec:
                    report["halfvec"] = halfvec_evaluation(connection, seed)
                    report["completed_stages"].append("experimental_halfvec")
                report["database_connections"] = first_value(
                    connection.execute(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE datname=current_database()"
                    )
                )
                report["status"] = "completed"
        except BaseException as exc:
            report["status"] = (
                "interrupted" if isinstance(exc, KeyboardInterrupt) else "failed"
            )
            report["error_type"] = type(exc).__name__  # No connection URL/credentials.
            raise
        finally:
            report["server_monitor"] = monitor.finish()
            admin.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name))
            )
            report["database_dropped"] = True
            report["elapsed_seconds"] = time.perf_counter() - started
            report["process_max_rss_kib"] = resource.getrusage(
                resource.RUSAGE_SELF
            ).ru_maxrss
            report["process_cpu_seconds"] = time.process_time()
            report["server_cpu_memory_measured"] = report["server_monitor"][
                "server_cpu_memory_measured"
            ]
            report["cloud_run_execution_measured"] = False
            write_report(arguments.output, report)
    print(
        json.dumps(
            {
                "status": report["status"],
                "assets": arguments.assets,
                "output": str(arguments.output),
                "database_dropped": True,
            }
        )
    )


if __name__ == "__main__":
    main()
