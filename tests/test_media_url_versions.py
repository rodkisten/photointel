"""Private image projections keep browser caches revision-scoped."""

from uuid import uuid4

from photointel.models import Asset, AssetResource, utcnow
from photointel.serializers import asset_out, resource_out


def test_gallery_url_changes_when_media_representation_changes() -> None:
    asset = Asset(
        id=uuid4(),
        library_id=uuid4(),
        source_asset_key="test-photo",
        media_type="image",
        filename="photo.heic",
        content_revision="source-v1",
        representation_revision="a" * 64,
        ingestion_status="completed",
        classification_status="pending",
        visibility_status="active",
        quality={},
        created_at=utcnow(),
    )
    first = asset_out(asset).thumbnail_url
    assert first is not None
    assert first.endswith("?v=" + "a" * 16)
    asset.representation_revision = "b" * 64
    latest = asset_out(asset).thumbnail_url
    assert latest != first
    assert latest is not None and latest.endswith("?v=" + "b" * 16)


def test_variant_urls_preserve_revision_and_avif_requires_negotiation() -> None:
    resource = AssetResource(
        id=uuid4(),
        asset_id=uuid4(),
        resource_type="preview_large",
        revision="c" * 64,
        status="available",
        mime_type="image/webp",
        created_at=utcnow(),
    )
    url = resource_out(resource).media_url
    assert url is not None and url.endswith("/preview_large?v=" + "c" * 16)
    resource.resource_type = "preview_large_avif"
    resource.mime_type = "image/avif"
    assert resource_out(resource).media_url is None
