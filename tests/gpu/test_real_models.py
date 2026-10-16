"""Explicit operator-only smoke test; normal test runs never spend GPU credits."""

import os
from uuid import UUID

import pytest


@pytest.mark.gpu
@pytest.mark.asyncio
async def test_real_models_persist_results_for_one_selected_asset() -> None:
    if os.environ.get("PHOTOINTEL_RUN_REAL_GPU") != "1":
        pytest.skip(
            "Real inference disabled: set PHOTOINTEL_RUN_REAL_GPU=1 only after "
            "reviewing provider costs and selecting a single test asset"
        )
    asset_identifier = os.environ.get("PHOTOINTEL_GPU_TEST_ASSET_ID")
    if not asset_identifier:
        pytest.skip(
            "Set PHOTOINTEL_GPU_TEST_ASSET_ID to one explicitly selected catalog asset"
        )
    try:
        asset_id = UUID(asset_identifier)
    except ValueError:
        pytest.fail("PHOTOINTEL_GPU_TEST_ASSET_ID must be a valid asset UUID")
    from photointel.config import get_settings

    settings = get_settings()
    if not settings.gpu_enabled:
        pytest.skip("Real inference also requires explicit GPU_ENABLED=true")
    if settings.inference_backend == "test":
        pytest.fail("A real GPU smoke test cannot use INFERENCE_BACKEND=test")
    from gpu.smoke import smoke

    # The real smoke validates database persistence, embedding dimension and a
    # finite text/image similarity; it never creates a synthetic model result.
    await smoke(asset_id)
