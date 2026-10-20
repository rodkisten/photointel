"""Operational CLI: synthetic development, diagnostics, export and benchmarks."""

import argparse
import asyncio
import csv
import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select, text

from photointel import __version__
from photointel.config import get_settings
from photointel.database import SessionLocal, engine
from photointel.models import Asset, AssetTag, Library, Tag


async def seed(count: int) -> dict[str, Any]:
    settings = get_settings()
    if settings.is_production:
        raise RuntimeError("Synthetic seeding is forbidden in production")
    from photointel.services.fixtures import generate_fixtures
    from photointel.services.ingestion import ingest_fixture_directory
    from photointel.services.jobs import claim_jobs
    from photointel.services.worker import execute_job

    directory = settings.temp_directory / "synthetic-fixtures"
    generate_fixtures(directory, count)
    async with SessionLocal() as session:
        result = await ingest_fixture_directory(
            session,
            directory,
            limit=count,
        )
        await session.commit()
    # Run the same durable pipeline as a worker; no inference credits are enabled.
    worker_id = "cli-seed"
    processed = 0
    for _ in range(count * 20 + 50):
        async with SessionLocal() as session:
            claimed = await claim_jobs(session, worker_id, limit=1)
            await session.commit()
        if not claimed:
            break
        for job in claimed:
            await execute_job(job.id, worker_id)
            processed += 1
    async with SessionLocal() as session:
        library = await session.scalar(
            select(Library).where(Library.source_type == "fixture").limit(1)
        )
        if library:
            assets = (
                await session.scalars(
                    select(Asset)
                    .where(Asset.library_id == library.id)
                    .order_by(Asset.filename)
                    .limit(count)
                )
            ).all()
            names = ["landscape", "beach", "plant", "abstract"]
            for index, asset in enumerate(assets):
                asset.captured_at = datetime(2020, 1, 1, tzinfo=UTC) + timedelta(
                    days=index * 90
                )
                asset.added_at = asset.created_at
                canonical = names[index % len(names)]
                tag = await session.scalar(
                    select(Tag).where(Tag.canonical_key == canonical)
                )
                if not tag:
                    tag = Tag(
                        canonical_key=canonical,
                        display_name={
                            "landscape": "Paisagem",
                            "beach": "Praia",
                            "plant": "Planta",
                            "abstract": "Abstrato",
                        }[canonical],
                        category="environment" if index % 4 < 3 else "visual",
                        sync_eligible=False,
                        minimum_confidence=0,
                    )
                    session.add(tag)
                    await session.flush()
                existing = await session.scalar(
                    select(AssetTag.id).where(
                        AssetTag.asset_id == asset.id,
                        AssetTag.tag_id == tag.id,
                        AssetTag.origin == "import",
                        AssetTag.model_version == "",
                    )
                )
                if not existing:
                    session.add(
                        AssetTag(
                            asset_id=asset.id,
                            tag_id=tag.id,
                            origin="import",
                            confidence=1,
                            user_status="approved",
                            review_status="approved",
                        )
                    )
            await session.commit()
    return {
        "source": "synthetic_fixture",
        "requested": count,
        "pipeline_jobs_executed": processed,
        "ingestion": jsonable_encoder(result),
        "notice": (
            "Arte sintética local; não representa biblioteca iCloud nem inferência real."
        ),
    }


async def export_all(output: Path) -> dict[str, Any]:
    from photointel.routers.operations import EXPORTS, iter_export

    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    exported: dict[str, int] = {}
    for kind in EXPORTS:
        path = output / f"{kind}.json"
        count = 0
        with path.open("w", encoding="utf-8") as handle:
            handle.write('{"kind":' + json.dumps(kind) + ',"items":[')
            async for record in iter_export(kind):
                if count:
                    handle.write(",")
                json.dump(record, handle, ensure_ascii=False)
                count += 1
            handle.write("]}\n")
        path.chmod(0o600)
        exported[kind] = count
    csv_path = output / "tags.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer: Any = None
        async for record in iter_export("taxonomy"):
            if writer is None:
                writer = csv.DictWriter(handle, fieldnames=list(record))
                writer.writeheader()
            for key, value in record.items():
                if isinstance(value, (dict, list)):
                    record[key] = json.dumps(value, ensure_ascii=False)
                if isinstance(record[key], str) and record[key].startswith(
                    ("=", "+", "-", "@")
                ):
                    record[key] = "'" + record[key]
            writer.writerow(record)
    csv_path.chmod(0o600)
    return {"output": str(output), "counts": exported, "embeddings_exported": False}


BENCHMARK_SIZES = {10000, 100000, 176000, 500000}
BENCHMARK_VECTOR_BATCH = 250


def validate_benchmark_options(
    count: int, vectors: int, repetitions: int, timeout_seconds: int
) -> None:
    if count not in BENCHMARK_SIZES:
        raise ValueError("Choose 10000, 100000, 176000 or 500000 metadata assets")
    if not 0 <= vectors <= min(count, 50000):
        raise ValueError("Vector count must be between zero and min(assets, 50000)")
    if not 1 <= repetitions <= 20:
        raise ValueError("Choose between 1 and 20 repetitions")
    if not 30 <= timeout_seconds <= 3600:
        raise ValueError("Benchmark timeout must be between 30 and 3600 seconds")


def benchmark_queries() -> dict[str, str]:
    """Bounded query templates; all changing values are database bind parameters."""
    return {
        "cursor_gallery": (
            "SELECT id,captured_at FROM assets WHERE library_id=:library_id "
            "ORDER BY captured_at DESC,id LIMIT 60"
        ),
        "cursor_next_page": (
            "SELECT id,captured_at FROM assets WHERE library_id=:library_id "
            "AND captured_at < :cursor_at ORDER BY captured_at DESC,id LIMIT 60"
        ),
        "metadata_filter": (
            "SELECT id FROM assets WHERE library_id=:library_id AND "
            "width>=2000 AND filesize<20000000 ORDER BY captured_at DESC,id LIMIT 60"
        ),
        "full_text": (
            "SELECT id FROM assets WHERE library_id=:library_id AND "
            "search_document @@ websearch_to_tsquery('simple','landscape') LIMIT 60"
        ),
    }


async def benchmark(
    count: int,
    output: Path,
    *,
    vectors: int = 0,
    repetitions: int = 5,
    timeout_seconds: int = 300,
) -> dict[str, Any]:
    """Measure actual PostgreSQL execution with synthetic data and rollback.

    Vector generation never loads the full dataset into Python and never runs a model.
    Use a disposable development database: rollback still generates WAL/dead tuples.
    """
    import statistics

    from photointel.models import ModelRegistry

    validate_benchmark_options(count, vectors, repetitions, timeout_seconds)
    settings = get_settings()
    if settings.is_production:
        raise RuntimeError("Benchmarks are forbidden in production")
    library_id = uuid4()
    started_at = datetime.now(UTC)
    benchmark_started = time.perf_counter()
    deadline = benchmark_started + timeout_seconds
    timings: dict[str, Any] = {}
    measurements: dict[str, Any] = {}
    result: dict[str, Any] = {
        "executed_at": started_at.isoformat(),
        "status": "running",
        "assets": count,
        "dataset": "synthetic_metadata_and_vectors" if vectors else "synthetic_metadata",
        "vector_count": vectors,
        "vector_dimension": settings.siglip_embedding_dimension,
        "real_model_inference": False,
        "timings": timings,
        "queries": measurements,
        "timeout_seconds": timeout_seconds,
        "notice": (
            "Medições reais deste banco com dados sintéticos; não medem a qualidade "
            "semântica do SigLIP 2 nem garantem a latência de produção."
        ),
    }

    async with SessionLocal() as session:

        async def bounded_execute(query: str, parameters: dict[str, Any] | None = None):
            remaining_ms = int((deadline - time.perf_counter()) * 1000)
            if remaining_ms <= 0:
                raise TimeoutError("Benchmark deadline reached")
            await session.execute(
                text("SELECT set_config('statement_timeout', :timeout, true)"),
                {"timeout": f"{remaining_ms}ms"},
            )
            return await session.execute(text(query), parameters or {})

        async def measure(name: str, query: str, parameters: dict[str, Any]) -> list[Any]:
            elapsed: list[float] = []
            rows: list[Any] = []
            for _ in range(repetitions):
                start = time.perf_counter()
                rows = list((await bounded_execute(query, parameters)).all())
                elapsed.append((time.perf_counter() - start) * 1000)
            plan = (
                await bounded_execute(
                    "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + query, parameters
                )
            ).scalar_one()
            measurements[name] = {
                "samples_ms": elapsed,
                "median_ms": statistics.median(elapsed),
                "minimum_ms": min(elapsed),
                "maximum_ms": max(elapsed),
                "returned_rows": len(rows),
                "query_plan": plan,
            }
            return rows

        try:
            server = (
                (
                    await bounded_execute(
                        "SELECT version() AS version, "
                        "current_setting('shared_buffers') AS shared_buffers, "
                        "current_setting('work_mem') AS work_mem, "
                        "(SELECT extversion FROM pg_extension WHERE extname='vector') "
                        "AS pgvector_version"
                    )
                )
                .mappings()
                .one()
            )
            result["server"] = dict(server)
            result["existing_asset_rows"] = (
                await bounded_execute("SELECT count(*) FROM assets")
            ).scalar_one()
            session.add(
                Library(
                    id=library_id,
                    source_type="benchmark",
                    source_identifier=f"benchmark-{library_id}",
                    name="Synthetic benchmark",
                )
            )
            await session.flush()
            start = time.perf_counter()
            await bounded_execute(
                """
                INSERT INTO assets (
                    id,library_id,source_asset_key,source_metadata,media_type,filename,
                    captured_at,added_at,width,height,filesize,content_revision,
                    representation_revision,ingestion_status,classification_status,
                    visibility_status,missing_scan_count,quality,created_at,updated_at,
                    search_document
                )
                SELECT gen_random_uuid(), :library_id, 'bench-'||g, '{}'::jsonb,
                    'image','synthetic-landscape-beach-'||g||'.jpg',
                    CAST(:captured_at AS timestamptz)-g*interval '1 hour',
                    now(),1600+(g%800),900+(g%600),100000+(g%10000000),'1','1',
                    'completed','pending','active',0,
                    jsonb_build_object('sharpness',g%100,'score',g%100),
                    now(),now(),to_tsvector('simple','synthetic landscape beach')
                FROM generate_series(1,:count) g
                """,
                {"library_id": library_id, "count": count, "captured_at": started_at},
            )
            timings["metadata_insert_seconds"] = time.perf_counter() - start
            await bounded_execute("ANALYZE assets")
            parameters = {
                "library_id": library_id,
                "cursor_at": started_at - timedelta(hours=60),
            }
            for name, query in benchmark_queries().items():
                await measure(name, query, parameters)
            if vectors:
                model_id = uuid4()
                # A separate inactive provider prevents synthetic vectors being served
                # by production searches or mistaken for model inference results.
                session.add(
                    ModelRegistry(
                        id=model_id,
                        provider=f"synthetic-benchmark-{library_id}",
                        model_name=settings.siglip_model_id,
                        revision=settings.siglip_model_revision,
                        architecture="siglip2",
                        embedding_dimension=settings.siglip_embedding_dimension,
                        parameters={"synthetic": True, "generator": "sql-sincos-v1"},
                        capabilities=[],
                        active=False,
                    )
                )
                await session.flush()
                start = time.perf_counter()
                for offset in range(0, vectors, BENCHMARK_VECTOR_BATCH):
                    await bounded_execute(
                        """
                        INSERT INTO embeddings (
                            id,asset_id,model_id,input_revision,vector,created_at
                        )
                        SELECT gen_random_uuid(), a.id, :model_id, '1',
                            l2_normalize(ARRAY(
                                SELECT (
                                    sin(g * 0.61803398875 + d * 0.127) +
                                    cos(g * d * 0.017)
                                )::real
                                FROM generate_series(1,768) d
                            )::vector(768)), now()
                        FROM generate_series(
                            CAST(:first AS integer), CAST(:last AS integer)
                        ) g
                        JOIN assets a ON a.library_id=:library_id
                            AND a.source_asset_key='bench-'||g
                        """,
                        {
                            "model_id": model_id,
                            "library_id": library_id,
                            "first": offset + 1,
                            "last": min(offset + BENCHMARK_VECTOR_BATCH, vectors),
                        },
                    )
                timings["vector_insert_with_hnsw_seconds"] = time.perf_counter() - start
                await bounded_execute("ANALYZE embeddings")
                validation = (
                    (
                        await bounded_execute(
                            "SELECT count(*) AS count, "
                            "min(vector_dims(vector)) AS dimension, "
                            "min(vector_norm(vector)) AS minimum_norm, "
                            "max(vector_norm(vector)) AS maximum_norm "
                            "FROM embeddings WHERE model_id=:model_id",
                            {"model_id": model_id},
                        )
                    )
                    .mappings()
                    .one()
                )
                result["vector_validation"] = dict(validation)
                query_vector = (
                    await bounded_execute(
                        "SELECT e.vector::text FROM embeddings e JOIN assets a "
                        "ON a.id=e.asset_id WHERE e.model_id=:model_id "
                        "AND a.source_asset_key='bench-1'",
                        {"model_id": model_id},
                    )
                ).scalar_one()
                vector_parameters = {"model_id": model_id, "query_vector": query_vector}
                ann = await measure(
                    "vector_ann",
                    "SELECT asset_id,vector <=> CAST(:query_vector AS vector(768)) "
                    "AS distance FROM embeddings WHERE model_id=:model_id "
                    "ORDER BY vector <=> CAST(:query_vector AS vector(768)) LIMIT 20",
                    vector_parameters,
                )
                exact = await measure(
                    "vector_exact",
                    "WITH exact AS MATERIALIZED (SELECT asset_id, "
                    "vector <=> CAST(:query_vector AS vector(768)) AS distance "
                    "FROM embeddings WHERE model_id=:model_id) "
                    "SELECT asset_id,distance FROM exact ORDER BY distance LIMIT 20",
                    vector_parameters,
                )
                exact_ids = {row[0] for row in exact}
                result["vector_recall_at_20"] = len(
                    {row[0] for row in ann} & exact_ids
                ) / len(exact_ids)
                result["ann_index_observed"] = "ix_embeddings_cosine_hnsw" in json.dumps(
                    measurements["vector_ann"]["query_plan"]
                )
                result["vector_probe_count"] = 1
                result["hnsw_ef_search"] = (
                    await bounded_execute("SHOW hnsw.ef_search")
                ).scalar_one()
            else:
                result["vector_benchmark"] = "Not requested; use --vectors 10000"
            result["status"] = "completed"
        except Exception as exc:
            result["status"] = "failed"
            result["error_type"] = type(exc).__name__
            raise
        finally:
            await session.rollback()
            result["records_rolled_back"] = True
            result["elapsed_seconds"] = time.perf_counter() - benchmark_started
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(
                json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            output.chmod(0o600)
    return result


async def doctor() -> dict[str, Any]:
    from photointel.storage import S3Storage, get_storage

    settings = get_settings()
    checks: dict[str, Any] = {}
    try:
        async with SessionLocal() as session:
            await session.execute(text("SELECT 1"))
            checks["database"] = "ready"
    except Exception as exc:
        checks["database"] = {"state": "unavailable", "error_type": type(exc).__name__}
    try:
        storage = get_storage()
        if isinstance(storage, S3Storage):
            await asyncio.to_thread(storage.client.head_bucket, Bucket=storage.bucket)
        checks["storage"] = "ready"
    except Exception as exc:
        checks["storage"] = {"state": "unavailable", "error_type": type(exc).__name__}
    checks["gpu"] = "configured_not_verified" if settings.gpu_enabled else "disabled"
    checks["icloud"] = (
        "configured_not_verified" if settings.icloud_enabled else "disabled"
    )
    return {
        "version": __version__,
        "environment": settings.app_env,
        "checks": checks,
        "privacy": "Segredos e configurações privadas omitidos.",
    }


async def async_main(arguments: argparse.Namespace) -> None:
    try:
        if arguments.command == "seed":
            result = await seed(arguments.synthetic_assets)
        elif arguments.command == "export":
            result = await export_all(Path(arguments.output))
        elif arguments.command == "benchmark":
            result = await benchmark(
                arguments.assets,
                Path(arguments.output),
                vectors=arguments.vectors,
                repetitions=arguments.repetitions,
                timeout_seconds=arguments.timeout_seconds,
            )
        elif arguments.command == "ingest-test":
            result = await seed(4)
        else:
            result = await doctor()
        print(json.dumps(jsonable_encoder(result), ensure_ascii=False, indent=2))
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(prog="photointel")
    subparsers = parser.add_subparsers(dest="command", required=True)
    seed_parser = subparsers.add_parser("seed")
    seed_parser.add_argument("--synthetic-assets", type=int, default=16)
    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("--output", default="exports")
    benchmark_parser = subparsers.add_parser("benchmark")
    benchmark_parser.add_argument("--assets", type=int, required=True)
    benchmark_parser.add_argument("--output", required=True)
    benchmark_parser.add_argument("--vectors", type=int, default=0)
    benchmark_parser.add_argument("--repetitions", type=int, default=5)
    benchmark_parser.add_argument("--timeout-seconds", type=int, default=300)
    doctor_parser = subparsers.add_parser("doctor")
    doctor_parser.add_argument("--json", action="store_true")
    subparsers.add_parser("ingest-test")
    asyncio.run(async_main(parser.parse_args()))


if __name__ == "__main__":
    main()
