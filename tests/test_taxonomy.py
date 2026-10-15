"""Versioned presentation taxonomy is deterministic and conservatively private."""

import pytest

from photointel.services.taxonomy import CATEGORIES, map_tag, select_predictions


def test_all_fourteen_categories_and_original_keys() -> None:
    assert len(CATEGORIES) == 14
    assert map_tag("black_shirt").canonical_key == "black_shirt"
    assert map_tag("black_shirt").display_name == "Camiseta preta"
    assert map_tag("black_shirt").category == "clothing"
    assert map_tag("1boy").category == "person"


def test_sensitive_and_unmapped_labels_conservatively_private() -> None:
    assert map_tag("penis").is_sensitive
    assert map_tag("bulge").is_sensitive
    assert map_tag("unreviewed_model_vocabulary").is_sensitive
    assert not map_tag("beach").is_sensitive


def test_custom_mapping_and_hierarchy() -> None:
    tag = map_tag("dark_top", {"dark_top": {
        "category": "clothing", "display_name": "Parte de cima escura",
        "aliases": ["Blusa escura"], "parent_key": "shirt", "is_sensitive": False,
    }})
    assert tag.parent_key == "shirt"
    assert "Blusa escura" in tag.aliases
    assert not tag.is_sensitive
    with pytest.raises(ValueError):
        map_tag("dark_top", {"dark_top": {"category": "identity"}})


def test_category_enable_and_thresholds_and_raw_retention() -> None:
    raw = {"sky": .6, "black_shirt": .7, "beach": .3, "1boy": .91}
    retained = dict(raw)
    chosen = select_predictions(raw, category_settings={
        "person": {"enabled": False}, "environment": {"minimum_confidence": .2},
    })
    assert [tag.canonical_key for tag, _ in chosen] == ["black_shirt", "sky", "beach"]
    assert raw == retained


def test_compound_and_not_rules_and_deterministic_limit() -> None:
    raw = {"sky": .9, "beach": .8, "black_shirt": .7}
    result = select_predictions(raw, maximum=4, compound_rules=[
        {"all": ["sky", "beach"], "none": ["indoors"], "output": "coastal_scene"},
        {"all": ["sky"], "none": ["beach"], "output": "not_beach"},
    ])
    assert [(tag.canonical_key, confidence) for tag, confidence in result] == [
        ("sky", .9), ("beach", .8), ("coastal_scene", .8), ("black_shirt", .7),
    ]


def test_threshold_bounds() -> None:
    with pytest.raises(ValueError):
        select_predictions({"sky": .9}, category_settings={
            "environment": {"minimum_confidence": 2},
        })
