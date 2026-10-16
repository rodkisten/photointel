"""Settings accept the generated deployment environment without weakening limits."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from photointel.config import Settings
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def isolated_settings_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    fields = {name.upper() for name in Settings.model_fields}
    for key in list(os.environ):
        if key.upper() in fields:
            monkeypatch.delenv(key)


def test_generated_development_environment_loads(tmp_path: Path) -> None:
    scripts = tmp_path / "infra" / "scripts"
    scripts.mkdir(parents=True)
    script = scripts / "setup-env.py"
    shutil.copy(ROOT / "infra" / "scripts" / "setup-env.py", script)
    shutil.copy(ROOT / ".env.example", tmp_path / ".env.example")
    subprocess.run(
        [sys.executable, str(script)], check=True, capture_output=True, text=True
    )

    settings = Settings(_env_file=tmp_path / ".env")

    assert settings.siglip_embedding_dimension == 768
    assert isinstance(settings.siglip_embedding_dimension, int)
    assert settings.storage_backend == "s3"
    assert settings.gpu_enabled is False


def test_siglip_dimension_loads_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SIGLIP_EMBEDDING_DIMENSION", "768")
    settings = Settings(_env_file=None)
    assert settings.siglip_embedding_dimension == 768
    assert isinstance(settings.siglip_embedding_dimension, int)


@pytest.mark.parametrize("value", ["767", "1024", "768.0", "0768", "768 ", ""])
def test_siglip_dimension_rejects_other_environment_values(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("SIGLIP_EMBEDDING_DIMENSION", value)
    with pytest.raises(ValidationError, match="siglip_embedding_dimension"):
        Settings(_env_file=None)


@pytest.mark.parametrize("value", [767, 1024])
def test_siglip_dimension_rejects_other_numeric_dimensions(value: int) -> None:
    with pytest.raises(ValidationError, match="siglip_embedding_dimension"):
        Settings(_env_file=None, siglip_embedding_dimension=value)
