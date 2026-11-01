"""Regression checks for privacy-safe correlation and finite worker wakeups."""
from uuid import uuid4

from photointel.observability import (
    correlation_context,
    current_correlation,
    job_correlation,
    valid_correlation,
)


def test_canonical_correlation_is_inherited_into_queued_work() -> None:
    identifier = str(uuid4())
    token = correlation_context.set(identifier)
    try:
        assert current_correlation() == identifier
        assert job_correlation({"job_type": "thumbnail_generate"}) == identifier
        assert job_correlation({"correlation_id": identifier}) == identifier
    finally:
        correlation_context.reset(token)


def test_untrusted_or_malformed_correlations_are_replaced() -> None:
    token = correlation_context.set(None)
    try:
        for value in ("private-photo-metadata", "deadbeef", str(uuid4()).upper(), None):
            assert valid_correlation(value) is None
        replacement = job_correlation({"correlation_id": "not-a-uuid"})
        assert valid_correlation(replacement) == replacement
    finally:
        correlation_context.reset(token)
