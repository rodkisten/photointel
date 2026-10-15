"""Deterministic taxonomy v1. Original model keys and user overrides are preserved."""

from dataclasses import dataclass
from typing import Any
from uuid import UUID

TAXONOMY_VERSION = "1.0.0"
CATEGORIES = {
    "person": "Pessoa", "body": "Corpo", "face_hair": "Rosto e cabelo",
    "clothing": "Vestuário", "clothing_bulge": "Volume sob a roupa",
    "pose_action": "Pose e ação", "sexual_action": "Ação sexual",
    "genitals": "Genitais", "penis": "Pênis", "environment": "Ambiente",
    "objects": "Objetos", "composition": "Composição", "visual": "Visual",
    "other": "Outros",
}
SENSITIVE_CATEGORIES = {"clothing_bulge", "sexual_action", "genitals", "penis"}

# Conservative keyword categorization is a presentation mapping, not a detector.
# Unknown model keys stay intact in `other`; operators can override any mapping.
CATEGORY_TERMS: dict[str, set[str]] = {
    "penis": {"penis", "erection", "foreskin", "glans", "testicles", "scrotum"},
    "genitals": {"pussy", "vulva", "vagina", "anus", "clitoris", "pubic"},
    "sexual_action": {
        "sex", "fellatio", "cunnilingus", "masturbation", "penetration",
        "handjob", "footjob", "paizuri", "orgasm", "cum", "ejaculation",
    },
    "clothing_bulge": {"bulge", "cameltoe", "crotch"},
    "person": {"boy", "girl", "boys", "girls", "male", "female", "man", "woman"},
    "body": {
        "body", "breasts", "nipples", "nude", "navel", "muscular", "abs",
        "thighs", "legs", "arms", "feet", "hands", "skin", "buttocks", "ass",
    },
    "face_hair": {
        "hair", "eyes", "eyebrows", "beard", "mustache", "mouth", "lips",
        "smile", "smiling", "teeth", "face", "ponytail", "bangs", "braid",
    },
    "clothing": {
        "shirt", "t-shirt", "dress", "pants", "shorts", "skirt", "jacket",
        "socks", "shoes", "hat", "cap", "uniform", "bikini", "underwear",
        "bra", "panties", "swimsuit", "gloves", "coat", "boots", "sweater",
    },
    "pose_action": {
        "standing", "sitting", "lying", "walking", "running", "jumping",
        "dancing", "crouching", "kneeling", "hugging", "holding", "reaching",
    },
    "environment": {
        "outdoors", "indoors", "beach", "forest", "mountain", "mountains",
        "sky", "cloud", "clouds", "sunset", "ocean", "sea", "room", "street",
        "park", "garden", "snow", "rain", "water", "sand", "city", "building",
    },
    "objects": {
        "plant", "flower", "flowers", "tree", "car", "book", "phone", "chair",
        "table", "bed", "cup", "food", "dog", "cat", "bird", "bicycle",
    },
    "composition": {
        "portrait", "close-up", "solo", "focus", "view", "background", "crop",
        "cropped", "profile", "perspective", "pov", "full-body",
    },
    "visual": {
        "monochrome", "grayscale", "blurry", "realistic", "photorealistic",
        "illustration", "comic", "greyscale", "watermark", "signature", "text",
    },
}

# Names translate labels only; no inferred identities or unsupported people counts.
PORTUGUESE = {
    "1boy": "Pessoa masculina", "1girl": "Pessoa feminina", "solo": "Uma pessoa",
    "black_shirt": "Camiseta preta", "white_shirt": "Camiseta branca",
    "shirt": "Camiseta", "t-shirt": "Camiseta", "beach": "Praia",
    "outdoors": "Ao ar livre", "indoors": "Ambiente interno", "portrait": "Retrato",
    "green_background": "Fundo verde", "plant": "Planta", "flower": "Flor",
    "flowers": "Flores", "mountain": "Montanha", "mountains": "Montanhas",
    "sunset": "Pôr do sol", "sky": "Céu", "water": "Água", "tree": "Árvore",
    "smile": "Sorriso", "smiling": "Sorrindo", "standing": "Em pé",
    "sitting": "Sentado", "lying": "Deitado", "long_hair": "Cabelo longo",
    "short_hair": "Cabelo curto", "black_hair": "Cabelo preto",
    "brown_hair": "Cabelo castanho", "blue_eyes": "Olhos azuis",
    "muscular": "Musculatura", "nude": "Nudez", "breasts": "Seios",
    "penis": "Pênis", "erection": "Ereção", "bulge": "Volume sob a roupa",
    "sex": "Sexo", "pussy": "Vulva", "monochrome": "Monocromático",
    "blurry": "Desfocado", "close-up": "Enquadramento próximo",
}


@dataclass(frozen=True)
class TaxonomyTag:
    canonical_key: str
    display_name: str
    category: str
    is_sensitive: bool
    aliases: tuple[str, ...]
    parent_key: str | None = None


def map_tag(key: str, overrides: dict[str, Any] | None = None) -> TaxonomyTag:
    if not key or len(key) > 255:
        raise ValueError("Invalid model tag key")
    override = (overrides or {}).get(key, {})
    terms = set(key.lower().replace("-", "_").split("_"))
    # Numeric Danbooru person labels are categories, never validated object counts.
    normalized = key.lower().lstrip("0123456789")
    if normalized in {"boy", "girl", "boys", "girls", "other"}:
        category = "person"
    else:
        category = next((
            category for category, words in CATEGORY_TERMS.items()
            if terms & words or key.lower() in words
        ), "other")
    category = str(override.get("category", category))
    if category not in CATEGORIES:
        raise ValueError("Unknown taxonomy category")
    display = str(override.get(
        "display_name", PORTUGUESE.get(key, key.replace("_", " ")),
    ))
    sensitive_terms = {"nude", "naked", "breasts", "nipples", "underwear", "panties"}
    sensitive = bool(override.get(
        "is_sensitive", category in SENSITIVE_CATEGORIES or category == "other"
        or bool(terms & sensitive_terms),
    ))
    aliases = tuple(dict.fromkeys([
        display, key.replace("_", " "), *override.get("aliases", []),
    ]))
    return TaxonomyTag(
        key, display, category, sensitive, aliases, override.get("parent_key"),
    )


def select_predictions(
    probabilities: dict[str, float], threshold: float = .4, maximum: int = 80,
    category_settings: dict[str, Any] | None = None,
    overrides: dict[str, Any] | None = None,
    compound_rules: list[dict[str, Any]] | None = None,
) -> list[tuple[TaxonomyTag, float]]:
    """Threshold raw probabilities without mutating retained model predictions."""
    if not 0 <= threshold <= 1 or not 1 <= maximum <= 1000:
        raise ValueError("Invalid taxonomy thresholds")
    result: list[tuple[TaxonomyTag, float]] = []
    category_settings = category_settings or {}
    for key, probability in probabilities.items():
        mapped = map_tag(key, overrides)
        config = category_settings.get(mapped.category, {})
        minimum = float(config.get("minimum_confidence", threshold))
        if not 0 <= minimum <= 1:
            raise ValueError("Invalid category threshold")
        if config.get("enabled", True) and probability >= minimum:
            result.append((mapped, probability))
    # Compound rules are deterministic AND/NOT tag predicates, never executable SQL/code.
    included = {tag.canonical_key: score for tag, score in result}
    for rule in compound_rules or []:
        required = rule.get("all", [])
        excluded = rule.get("none", [])
        if not required or not all(key in included for key in required):
            continue
        if any(key in included for key in excluded):
            continue
        output = map_tag(str(rule["output"]), overrides)
        result.append((output, min(included[key] for key in required)))
    # Stable order makes migrations/rethresholding reproducible.
    best: dict[str, tuple[TaxonomyTag, float]] = {}
    for tag, probability in result:
        prior = best.get(tag.canonical_key)
        if prior is None or probability > prior[1]:
            best[tag.canonical_key] = (tag, probability)
    return sorted(
        best.values(), key=lambda item: (-item[1], item[0].canonical_key),
    )[:maximum]


async def migrate_taxonomy(session) -> None:
    """Idempotent versioned data migration; existing operator mappings remain intact."""
    from sqlalchemy import select
    from sqlalchemy.dialects.postgresql import insert

    from photointel.models import Setting, Tag, TagAlias

    marker = await session.get(Setting, "taxonomy_schema_version")
    if marker and marker.value == TAXONOMY_VERSION:
        return
    if marker:
        current = tuple(int(part) for part in str(marker.value).split("."))
        expected = tuple(int(part) for part in TAXONOMY_VERSION.split("."))
        if current > expected:
            raise ValueError("Taxonomy downgrade is not supported")
    tags = [map_tag(key) for key in sorted(PORTUGUESE)]
    await session.execute(insert(Tag).values([{
        "canonical_key": tag.canonical_key, "display_name": tag.display_name,
        "category": tag.category, "is_sensitive": tag.is_sensitive,
        "minimum_confidence": 0,
    } for tag in tags]).on_conflict_do_nothing(index_elements=["canonical_key"]))
    stored = (await session.scalars(select(Tag).where(
        Tag.canonical_key.in_([tag.canonical_key for tag in tags]),
    ))).all()
    by_key = {tag.canonical_key: tag.id for tag in stored}
    aliases = [{
        "tag_id": by_key[tag.canonical_key], "alias": alias,
        "language": "en" if alias == tag.canonical_key.replace("_", " ") else "pt-BR",
        "alias_type": "display",
    } for tag in tags for alias in tag.aliases]
    await session.execute(insert(TagAlias).values(aliases).on_conflict_do_nothing())
    marker_insert = insert(Setting).values(
        key="taxonomy_schema_version", value=TAXONOMY_VERSION,
    )
    await session.execute(marker_insert.on_conflict_do_update(
        index_elements=["key"], set_={"value": TAXONOMY_VERSION},
    ))


async def resolve_tag_targets(session, tags: list) -> dict[UUID, Any]:
    """Resolve bounded merge chains in SQL, preserving original prediction keys."""
    from sqlalchemy import select, text

    from photointel.models import Tag

    if not tags:
        return {}
    direct = {tag.id: tag for tag in tags if tag.merged_into_id is None}
    sources = [tag.id for tag in tags if tag.merged_into_id is not None]
    if not sources:
        return direct
    resolved = (await session.execute(text("""
        WITH RECURSIVE chain AS (
            SELECT id AS source_id,id,merged_into_id,0 AS depth,ARRAY[id] AS path
            FROM tags WHERE id=ANY(:source_ids)
            UNION ALL
            SELECT c.source_id,t.id,t.merged_into_id,c.depth+1,c.path||t.id
            FROM chain c JOIN tags t ON t.id=c.merged_into_id
            WHERE c.depth<64 AND NOT t.id=ANY(c.path)
        )
        SELECT source_id,id FROM chain WHERE merged_into_id IS NULL
    """), {"source_ids": sources})).all()
    if len(resolved) != len(sources):
        raise ValueError("Tag merge chain is invalid or exceeds 64 levels")
    target_ids = {row.id for row in resolved}
    targets = (await session.scalars(select(Tag).where(Tag.id.in_(target_ids)))).all()
    by_id = {tag.id: tag for tag in targets}
    direct.update({row.source_id: by_id[row.id] for row in resolved})
    return direct
