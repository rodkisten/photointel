"""Local infrastructure safety checks require no Docker/network/services."""

import ast
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]


def test_compose_tmpfs_options_form_one_absolute_mount():
    for configuration in sorted((ROOT / "infra" / "docker").glob("compose.*.yml")):
        declarations = re.findall(
            r"^\s*tmpfs:\s*(\[[^\n]+\])\s*$", configuration.read_text(), re.MULTILINE
        )
        assert declarations, f"No tmpfs declarations found in {configuration.name}"
        sizes = []
        for declaration in declarations:
            # Quoted Python/JSON string lists are also YAML flow lists. Requiring
            # quoting prevents YAML from splitting comma-separated mount options.
            mounts = ast.literal_eval(declaration)
            assert isinstance(mounts, list) and len(mounts) == 1
            mount = mounts[0]
            assert isinstance(mount, str)
            target, separator, options = mount.partition(":")
            assert separator and PurePosixPath(target).is_absolute()
            assert target == "/tmp"
            flags = set(options.split(","))
            assert {"rw", "noexec", "nosuid"} <= flags
            size = flags - {"rw", "noexec", "nosuid"}
            assert len(size) == 1 and size <= {"size=64m", "size=256m"}
            sizes.extend(size)
        assert sorted(sizes) == ["size=256m", "size=64m"]


def copied_script(tmp_path: Path, filename: str) -> Path:
    directory = tmp_path / "infra" / "scripts"
    directory.mkdir(parents=True)
    target = directory / filename
    shutil.copy(ROOT / "infra" / "scripts" / filename, target)
    return target


def test_setup_creates_private_credentials_and_preserves_configuration(tmp_path: Path):
    script = copied_script(tmp_path, "setup-env.py")
    shutil.copy(ROOT / ".env.example", tmp_path / ".env.example")
    result = subprocess.run(
        [sys.executable, str(script)], check=True, capture_output=True, text=True
    )
    configuration = tmp_path / ".env"
    assert stat.S_IMODE(configuration.stat().st_mode) == 0o600
    contents = configuration.read_text()
    assert "GENERATE_WITH_MAKE_SETUP" not in contents
    secret = next(
        line.partition("=")[2]
        for line in contents.splitlines()
        if line.startswith("POSTGRES_PASSWORD=")
    )
    assert len(secret) >= 32
    assert secret not in result.stdout + result.stderr
    configuration.write_text("APP_ENV=test\nPRESERVE=existing-user-values\n")
    subprocess.run([sys.executable, str(script)], check=True, capture_output=True)
    assert "PRESERVE=existing-user-values" in configuration.read_text()
    assert stat.S_IMODE((tmp_path / "var" / "icloud-session").stat().st_mode) == 0o700


def test_production_runtime_is_private_and_excludes_database_admin_secrets(
    tmp_path: Path,
):
    script = copied_script(tmp_path, "prepare-production-env.py")
    shutil.copy(ROOT / ".env.runtime.example", tmp_path / ".env.runtime.example")
    result = subprocess.run(
        [sys.executable, str(script)], check=True, capture_output=True, text=True
    )
    target = tmp_path / ".env.runtime"
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    lines = target.read_text().splitlines()
    assert "APP_ENV=production" in lines
    assert "AUTH_MODE=cloudflare" in lines
    assert not any(
        line.startswith(("POSTGRES_", "MIGRATION_DATABASE_URL=")) for line in lines
    )
    pepper = next(
        line.partition("=")[2]
        for line in lines
        if line.startswith("BRIDGE_TOKEN_PEPPER=")
    )
    assert len(pepper) == 64
    assert pepper not in result.stdout + result.stderr
    target.write_text("PRESERVE=operator-configuration\n")
    subprocess.run([sys.executable, str(script)], check=True, capture_output=True)
    assert target.read_text() == "PRESERVE=operator-configuration\n"


def test_cleanup_refuses_another_directory_and_symlinks(tmp_path: Path):
    script = copied_script(tmp_path, "cleanup-temp.py")
    originals = tmp_path / "originals" / "processing"
    originals.mkdir(parents=True)
    original = originals / "irreplaceable.jpg"
    original.write_bytes(b"original-content")
    old = time.time() - 48 * 3600
    os.utime(original, (old, old))
    result = subprocess.run(
        [sys.executable, str(script), "--directory", str(originals), "--apply"],
        capture_output=True,
    )
    assert result.returncode != 0
    assert original.read_bytes() == b"original-content"
    (tmp_path / "var").mkdir()
    (tmp_path / "var" / "processing").symlink_to(originals, target_is_directory=True)
    result = subprocess.run(
        [sys.executable, str(script), "--directory", "var/processing", "--apply"],
        cwd=tmp_path,
        capture_output=True,
    )
    assert result.returncode != 0
    assert original.exists()


def test_cleanup_only_removes_expired_regular_temporary_files(tmp_path: Path):
    script = copied_script(tmp_path, "cleanup-temp.py")
    directory = tmp_path / "var" / "processing"
    directory.mkdir(parents=True)
    stale = directory / "stale.webp"
    fresh = directory / "fresh.webp"
    original = tmp_path / "original.heic"
    stale.write_bytes(b"old-derivative")
    fresh.write_bytes(b"fresh-derivative")
    original.write_bytes(b"original")
    (directory / "linked.heic").symlink_to(original)
    old = time.time() - 48 * 3600
    os.utime(stale, (old, old))
    subprocess.run(
        [sys.executable, str(script), "--apply"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
    )
    assert not stale.exists()
    assert fresh.exists()
    assert original.read_bytes() == b"original"
    assert (directory / "linked.heic").is_symlink()


def test_e2e_runner_refuses_production_or_real_inference():
    configurations = [
        {"APP_ENV": "production", "INFERENCE_BACKEND": "test"},
        {"APP_ENV": "test", "INFERENCE_BACKEND": "modal"},
        {
            "APP_ENV": "test",
            "INFERENCE_BACKEND": "test",
            "JOYTAG_MODEL_REVISION": "a" * 40,
        },
    ]
    for overrides in configurations:
        environment = dict(
            os.environ,
            GPU_ENABLED="true",
            JOYTAG_MODEL_REVISION="1" * 40,
            SIGLIP_MODEL_REVISION="2" * 40,
        )
        environment.update(overrides)
        result = subprocess.run(
            ["bash", str(ROOT / "infra/scripts/run-e2e.sh")],
            env=environment,
            capture_output=True,
            text=True,
            timeout=5,
        )
        assert result.returncode == 2
        assert "E2E exige" in result.stderr


def test_restore_ci_refuses_production_and_invalid_container():
    configurations = [
        ({"APP_ENV": "production"}, "database", "requires APP_ENV=test"),
        ({"APP_ENV": "test"}, "unsafe;command", "Invalid PostgreSQL container"),
    ]
    for overrides, container, message in configurations:
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "infra/scripts/restore-ci.py"),
                "--postgres-container",
                container,
            ],
            env=dict(os.environ, **overrides),
            capture_output=True,
            text=True,
            timeout=5,
        )
        assert result.returncode != 0
        assert message in result.stderr
