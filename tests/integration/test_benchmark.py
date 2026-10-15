"""Real finite SQL-generated vectors, query execution and complete record rollback."""

import json
from pathlib import Path

import pytest
from photointel.cli import benchmark
from photointel.database import SessionLocal
from sqlalchemy import text

pytestmark = pytest.mark.integration


async def test_synthetic_benchmark_executes_vectors_and_rolls_back(
    tmp_path: Path,
) -> None:
    async with SessionLocal() as session:
        before = (await session.execute(text("SELECT count(*) FROM assets"))).scalar_one()
    output = tmp_path / "benchmark.json"
    report = await benchmark(10000, output, vectors=32, repetitions=1, timeout_seconds=60)
    assert report["status"] == "completed"
    assert report["real_model_inference"] is False
    assert report["records_rolled_back"] is True
    assert report["vector_validation"]["count"] == 32
    assert report["vector_validation"]["dimension"] == 768
    assert report["vector_validation"]["minimum_norm"] == pytest.approx(1, abs=1e-5)
    assert report["vector_validation"]["maximum_norm"] == pytest.approx(1, abs=1e-5)
    assert 0 <= report["vector_recall_at_20"] <= 1
    for query in report["queries"].values():
        assert query["samples_ms"][0] >= 0
        assert query["query_plan"][0]["Execution Time"] >= 0
        assert query["returned_rows"] > 0
    assert json.loads(output.read_text())["status"] == "completed"
    async with SessionLocal() as session:
        after = (await session.execute(text("SELECT count(*) FROM assets"))).scalar_one()
        remaining = (
            await session.execute(
                text(
                    "SELECT count(*) FROM model_registry "
                    "WHERE provider LIKE 'synthetic-benchmark-%'"
                )
            )
        ).scalar_one()
    assert after == before
    assert remaining == 0
