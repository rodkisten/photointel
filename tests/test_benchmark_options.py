"""Bounds reject expensive accidental runs before acquiring a database session."""

import pytest
from photointel.cli import validate_benchmark_options


@pytest.mark.parametrize("count", [10000, 100000, 176000, 500000])
def test_supported_metadata_scales(count: int) -> None:
    validate_benchmark_options(count, 0, 5, 300)
    validate_benchmark_options(count, min(count, 50000), 1, 3600)


@pytest.mark.parametrize(
    "options",
    [
        (176001, 0, 5, 300),
        (10000, -1, 5, 300),
        (10000, 10001, 5, 300),
        (176000, 50001, 5, 300),
        (10000, 0, 0, 300),
        (10000, 0, 21, 300),
        (10000, 0, 5, 29),
        (10000, 0, 5, 3601),
    ],
)
def test_reject_unbounded_or_invalid_work(options: tuple[int, int, int, int]) -> None:
    with pytest.raises(ValueError):
        validate_benchmark_options(*options)
