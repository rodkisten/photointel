"""Bulk edits keep PostgreSQL parameter counts bounded without losing decisions."""

from uuid import uuid4

from photointel.models import AssetTag
from photointel.services.catalog import ASSERTION_BATCH_SIZE, assertion_batches
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import insert


def test_maximum_bulk_edit_batches_preserve_every_asset_and_decision() -> None:
    assets = [uuid4() for _ in range(500)]
    decisions = {uuid4(): "rejected" if index % 2 else "approved" for index in range(300)}
    count = 0
    rejected = 0
    for index, batch in enumerate(assertion_batches(assets, decisions)):
        assert 0 < len(batch) <= ASSERTION_BATCH_SIZE
        # PostgreSQL's asyncpg protocol rejects more than 32,767 parameters.
        if index == 0:
            compiled = (
                insert(AssetTag).values(batch).compile(dialect=postgresql.dialect())
            )
            assert len(compiled.params) < 32767
        count += len(batch)
        rejected += sum(row["user_status"] == "rejected" for row in batch)
        assert all(row["origin"] == "user" for row in batch)
    assert count == 150000
    assert rejected == 75000


def test_empty_decisions_produce_no_sql_batch() -> None:
    assert list(assertion_batches([uuid4()], {})) == []
