"""Cloud Run Jobs reject unbounded execution and never accept import authorization."""

import pytest
from photointel.services.task_runner import MODES, parser, validate_bounds


def test_finite_task_limits_are_explicit_and_bounded() -> None:
    validate_bounds(100, 540)
    validate_bounds(1000, 3600)
    for jobs, seconds in ((0, 540), (10001, 540), (100, 0), (100, 86401)):
        with pytest.raises(ValueError):
            validate_bounds(jobs, seconds)
    for mode in MODES:
        arguments = parser().parse_args([mode, "--max-jobs", "500"])
        assert arguments.max_jobs == 500
        assert arguments.deadline_seconds == 540


def test_task_runner_cannot_authorize_large_import_by_cli() -> None:
    with pytest.raises(SystemExit):
        parser().parse_args(["backfill", "--import-limit", "176000"])
