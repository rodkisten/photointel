"""Search accepts a bounded typed AST, never executable expressions."""

from uuid import uuid4

import pytest
from photointel.errors import AppError
from photointel.schemas import FilterNode, SearchRequest
from photointel.serializers import decode_cursor, decode_uuid_cursor, encode_cursor
from photointel.services.search import filter_expression
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql


def test_nested_filters_are_parameterized_and_use_exists() -> None:
    request = SearchRequest(
        filter=FilterNode(
            op="and",
            children=[
                FilterNode(op="tag", value="black_shirt", confidence=0.75),
                FilterNode(op="number", key="filesize", comparison="lt", value=20000000),
                FilterNode(op="not", children=[FilterNode(op="screenshots", value=True)]),
            ],
        )
    )
    compiled = filter_expression(request.filter).compile(dialect=postgresql.dialect())
    assert "EXISTS" in str(compiled)
    assert "black_shirt" in compiled.params.values()
    assert "black_shirt" not in str(compiled)
    assert "rejected" in compiled.params.values()


@pytest.mark.parametrize("with_preview", [True, False])
def test_preview_availability_is_server_filtered_and_parameterized(with_preview: bool) -> None:
    node = FilterNode(op="has_preview", value=with_preview)
    compiled = filter_expression(node).compile(dialect=postgresql.dialect())
    statement = str(compiled)
    assert "asset_resources" in statement
    assert "EXISTS" in statement
    assert "representation_revision" in statement
    assert "thumbnail_medium" in compiled.params.values() or (
        "thumbnail_medium" in str(compiled.params.values())
    )


@pytest.mark.parametrize(
    "node",
    [
        {"op": "number", "key": "DROP TABLE assets", "value": 1},
        {"op": "not", "children": []},
        {"op": "date", "key": "source_account", "minimum": "2020-01-01"},
        {"op": "tag", "value": "shirt", "sql": "DELETE FROM assets"},
        {"op": "quality", "key": "people_count", "value": 2},
        {"op": "number", "key": "filesize", "value": "NaN"},
        {"op": "quality", "key": "score", "minimum": "inf"},
        {"op": "number", "key": "width", "minimum": 1000, "maximum": 100},
        {"op": "screenshots", "value": "false"},
        {"op": "duplicate", "value": "true"},
        {"op": "media_type", "value": "arbitrary"},
        {"op": "has_preview"},
        {"op": "has_preview", "value": "true"},
    ],
)
def test_unknown_or_unimplemented_fields_rejected(node: dict) -> None:
    with pytest.raises(ValidationError):
        FilterNode.model_validate(node)


def test_recursive_resource_limit() -> None:
    node = FilterNode(op="tag", value="plant")
    for _ in range(10):
        node = FilterNode(op="not", children=[node])
    with pytest.raises(ValidationError):
        SearchRequest(filter=node)


def test_cursor_roundtrip_and_invalid_input() -> None:
    cursor = encode_cursor({"id": uuid4(), "value": 123})
    assert decode_cursor(cursor)["value"] == 123
    with pytest.raises(AppError):
        decode_cursor("%%%")


def test_datetime_filter_rejects_malformed_input() -> None:
    with pytest.raises(AppError):
        filter_expression(FilterNode(op="date", key="captured_at", minimum="not-a-date"))


@pytest.mark.parametrize("data", [{}, {"id": None}, {"id": "bad"}, {"id": []}])
def test_uuid_cursor_rejects_missing_or_invalid_id(data: dict) -> None:
    with pytest.raises(AppError) as error:
        decode_uuid_cursor(encode_cursor(data))
    assert error.value.status_code == 422


@pytest.mark.parametrize("cursor", ["a" * 4097, "%%%%", "e30!", "eyJpZCI6TmFOfQ"])
def test_cursor_rejects_oversized_non_base64_and_nonfinite_json(cursor: str) -> None:
    with pytest.raises(AppError):
        decode_cursor(cursor)
