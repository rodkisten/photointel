"""Capacity tooling must never touch hosted or production databases."""

import argparse
import json
import runpy
from pathlib import Path

import pytest
from photointel.config import Settings

BENCHMARK = runpy.run_path(
    str(Path(__file__).parents[1] / "infra/scripts/capacity-benchmark.py")
)


@pytest.mark.parametrize(
    "url,confirmation,count",
    [
        ("postgresql://u:p@ep-example.neon.tech/production", "SYNTHETIC_ONLY", 1000),
        ("postgresql://u:p@localhost/production", "", 1000),
        ("postgresql://u:p@localhost/production", "SYNTHETIC_ONLY", 176001),
    ],
)
def test_benchmark_rejects_hosted_targets_and_missing_opt_in(
    url: str,
    confirmation: str,
    count: int,
) -> None:
    with pytest.raises(ValueError):
        BENCHMARK["validate_target"](url, confirmation, count)


def test_benchmark_rejects_production_even_on_localhost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(ValueError, match="production"):
        BENCHMARK["validate_target"](
            "postgresql://u:p@localhost/database", "SYNTHETIC_ONLY", 1000
        )


@pytest.mark.parametrize("value", ["--all", "container;rm", "../container", ""])
def test_monitor_container_is_a_literal_name(value: str) -> None:
    with pytest.raises(argparse.ArgumentTypeError):
        BENCHMARK["validate_container"](value)


def test_sigterm_unwinds_finally_for_disposable_database_cleanup() -> None:
    cleaned = False
    with pytest.raises(KeyboardInterrupt):
        try:
            BENCHMARK["terminate_gracefully"](15, None)
        finally:
            cleaned = True
    assert cleaned


def test_capacity_report_is_atomically_replaced(tmp_path: Path) -> None:
    path = tmp_path / "report.json"
    BENCHMARK["write_report"](path, {"status": "running"})
    BENCHMARK["write_report"](path, {"status": "completed"})
    assert json.loads(path.read_text()) == {"status": "completed"}
    assert not path.with_name("report.json.partial").exists()


def test_small_latency_sample_does_not_claim_p99() -> None:
    assert BENCHMARK["metrics"]([1.0, 2.0, 3.0])["p99_ms"] is None


def test_synthetic_registry_and_api_use_current_preprocessing_namespace() -> None:
    # A registry seeded with the old preprocessing namespace causes the real
    # API to reject these synthetic embeddings instead of benchmarking search.
    assert (
        BENCHMARK["PREPROCESSING_REVISION"]
        == Settings.model_fields["query_preprocessing_revision"].default
    )


def test_capacity_preflight_reserves_space_for_other_services() -> None:
    result = BENCHMARK["storage_preflight"](176000, 30, 8 * 1024**3, 5)
    assert result["allowed"] is False
    assert result["minimum_free_bytes_after_fixture"] == 5 * 1024**3
    assert result["estimate_is_measurement"] is False
    assert result["provider_quota_measured"] is False


def test_capacity_preflight_allows_small_disposable_fixture_with_headroom() -> None:
    result = BENCHMARK["storage_preflight"](1000, 30, 8 * 1024**3, 5)
    assert result["allowed"] is True
    assert result["estimated_fixture_bytes"] == 32000000
