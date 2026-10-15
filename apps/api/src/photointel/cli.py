"""Operational CLI: synthetic development, diagnostics, export and benchmarks."""

import argparse
import asyncio
import csv
import json
import math
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, select, text

from photointel.config import get_settings
from photointel.database import SessionLocal, engine
from photointel.models import Asset, AssetMetadata, AssetTag, Library, Tag


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
            session, directory, limit=count,
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
        library = await session.scalar(select(Library).where(
            Library.source_type == "fixture"
        ).limit(1))
        if library:
            assets = (await session.scalars(select(Asset).where(
                Asset.library_id == library.id
            ).order_by(Asset.filename).limit(count))).all()
            names = ["landscape", "beach", "plant", "abstract"]
            for index, asset in enumerate(assets):
                canonical = names[index % len(names)]
                tag = await session.scalar(select(Tag).where(Tag.canonical_key == canonical))
                if not tag:
                    tag = Tag(
                        canonical_key=canonical,
                        display_name={"landscape": "Paisagem", "beach": "Praia",
                                      "plant": "Planta", "abstract": "Abstrato"}[canonical],
                        category="environment" if index % 4 < 3 else "visual",
                        sync_eligible=False, minimum_confidence=0,
                    )
                    session.add(tag)
                    await session.flush()
                existing = await session.scalar(select(AssetTag.id).where(
                    AssetTag.asset_id == asset.id, AssetTag.tag_id == tag.id,
                    AssetTag.origin == "import", AssetTag.model_version == "",
                ))
                if not existing:
                    session.add(AssetTag(
                        asset_id=asset.id, tag_id=tag.id, origin="import",
                        confidence=1, user_status="approved", review_status="approved",
                    ))
            await session.commit()
    return {
        "source": "synthetic_fixture", "requested": count,
        "pipeline_jobs_executed": processed, "ingestion": jsonable_encoder(result),
        "notice": "Arte sintética local; não representa biblioteca iCloud nem inferência real.",
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
                if isinstance(record[key], str) and record[key].startswith(("=", "+", "-", "@")):
                    record[key] = "'" + record[key]
            writer.writerow(record)
    csv_path.chmod(0o600)
    return {"output": str(output), "counts": exported, "embeddings_exported": False}


async def benchmark(count: int, output: Path) -> dict[str, Any]:
    """Synthetic metadata in an isolated transaction, rolled back after measurement."""
    if count not in {10000, 100000, 176000, 500000}:
        raise ValueError("Choose 10000, 100000, 176000 or 500000")
    library_id = uuid4()
    timings: dict[str, float] = {}
    plans: dict[str, Any] = {}
    async with SessionLocal() as session:
        library = Library(
            id=library_id, source_type="benchmark",
            source_identifier=f"benchmark-{library_id}", name="Synthetic benchmark",
        )
        session.add(library)
        await session.flush()
        start = time.perf_counter()
        await session.execute(text("""
            INSERT INTO assets (
                id,library_id,source_asset_key,source_metadata,media_type,filename,
                captured_at,added_at,width,height,filesize,content_revision,
                representation_revision,ingestion_status,classification_status,
                visibility_status,missing_scan_count,quality,created_at,updated_at,
                search_document
            )
            SELECT gen_random_uuid(), :library_id, 'bench-'||g, '{}'::jsonb,
                'image','synthetic-'||g||'.jpg',now()-g*interval '1 hour',
                now(),1600+(g%800),900+(g%600),100000+(g%10000000),'1','1',
                'completed','pending','active',0,
                jsonb_build_object('sharpness',g%100,'score',g%100),
                now(),now(),to_tsvector('simple','synthetic landscape beach')
            FROM generate_series(1,:count) g
        """), {"library_id": library_id, "count": count})
        timings["insert_seconds"] = time.perf_counter() - start
        await session.execute(text("ANALYZE assets"))
        queries = {
            "cursor_gallery": (
                "SELECT id,captured_at FROM assets WHERE library_id=:library_id "
                "ORDER BY captured_at DESC,id LIMIT 60"
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
        for name, query in queries.items():
            elapsed = []
            for _ in range(5):
                start = time.perf_counter()
                await session.execute(text(query), {"library_id": library_id})
                elapsed.append((time.perf_counter() - start) * 1000)
            elapsed.sort()
            timings[f"{name}_median_ms"] = elapsed[2]
            plan = await session.scalar(text(
                "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + query
            ), {"library_id": library_id})
            plans[name] = plan
        # Rollback removes every generated metadata record; private catalog is preserved.
        await session.rollback()
    result = {
        "executed_at": datetime.now(UTC).isoformat(), "assets": count,
        "dataset": "synthetic_metadata", "timings": timings, "query_plans": plans,
        "vector_dimension": get_settings().siglip_embedding_dimension,
        "vector_benchmark": "Not measured by this metadata run",
        "notice": "Medições deste ambiente; não garantem performance de produção.",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    return result


async def doctor() -> dict[str, Any]:
    from photointel.storage import get_storage
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
        if hasattr(storage, "client"):
            await asyncio.to_thread(storage.client.head_bucket, Bucket=storage.bucket)
        checks["storage"] = "ready"
    except Exception as exc:
        checks["storage"] = {"state": "unavailable", "error_type": type(exc).__name__}
    checks["gpu"] = "configured_not_verified" if settings.gpu_enabled else "disabled"
    checks["icloud"] = "configured_not_verified" if settings.icloud_enabled else "disabled"
    return {
        "version": "1.0.0", "environment": settings.app_env, "checks": checks,
        "privacy": "Segredos e configurações privadas omitidos.",
    }


async def async_main(arguments: argparse.Namespace) -> None:
    try:
        if arguments.command == "seed":
            result = await seed(arguments.synthetic_assets)
        elif arguments.command == "export":
            result = await export_all(Path(arguments.output))
        elif arguments.command == "benchmark":
            result = await benchmark(arguments.assets, Path(arguments.output))
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
    doctor_parser = subparsers.add_parser("doctor")
    doctor_parser.add_argument("--json", action="store_true")
    subparsers.add_parser("ingest-test")
    asyncio.run(async_main(parser.parse_args()))


if __name__ == "__main__":
    main()
