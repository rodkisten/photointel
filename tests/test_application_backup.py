"""Real encryption/object-byte integrity; no Apple/cloud accounts or real photos."""

import base64
import io
import json
import os
from pathlib import Path

import pytest
from photointel.errors import AppError
from photointel.services.backup import (
    CHUNK_BYTES,
    BackupError,
    BackupReader,
    BackupWriter,
    load_key,
    postgres_environment,
)


def create_fixture(directory: Path):
    key = os.urandom(32)
    writer = BackupWriter(directory, key)
    payload = b"synthetic-private-image" * 100
    writer.add(
        "objects/assets/fixture/preview.webp",
        io.BytesIO(payload),
        metadata={"object_key": "assets/fixture/preview.webp"},
    )
    writer.add("postgres.dump", io.BytesIO(b"synthetic database bytes"))
    writer.finish({"migration_heads": ["test"], "object_count": 1})
    return key, payload


def test_private_content_is_encrypted_and_restores_exact_bytes(tmp_path: Path):
    directory = tmp_path / "backup"
    key, payload = create_fixture(directory)
    reader = BackupReader(directory, key)
    entry = reader.manifest["files"][0]
    assert b"".join(reader.chunks(entry)) == payload
    assert reader.verify()["files_verified"] == 2
    for path in directory.rglob("*"):
        assert path.stat().st_mode & 0o077 == 0
        if path.is_file():
            assert payload not in path.read_bytes()
    # Logical names remain in the authenticated encrypted manifest only.
    assert "preview.webp" not in (directory / "backup.json").read_text()


def test_large_content_round_trips_independent_chunks(tmp_path: Path):
    key = os.urandom(32)
    writer = BackupWriter(tmp_path / "backup", key)
    content = b"x" * (CHUNK_BYTES + 100)
    writer.add("postgres.dump", io.BytesIO(content))
    writer.finish({})
    reader = BackupReader(tmp_path / "backup", key)
    assert len(reader.manifest["files"][0]["chunks"]) == 2
    assert b"".join(reader.chunks(reader.manifest["files"][0])) == content


def test_wrong_key_and_tampered_manifest_are_rejected(tmp_path: Path):
    directory = tmp_path / "backup"
    key, _ = create_fixture(directory)
    with pytest.raises(BackupError):
        BackupReader(directory, os.urandom(32))
    manifest = directory / "manifest.enc"
    manifest.write_bytes(manifest.read_bytes()[:-1] + b"!")
    with pytest.raises(BackupError):
        BackupReader(directory, key)


def test_missing_or_corrupt_object_chunk_is_detected(tmp_path: Path):
    directory = tmp_path / "backup"
    key, _ = create_fixture(directory)
    reader = BackupReader(directory, key)
    chunk = directory / reader.manifest["files"][0]["chunks"][0]["path"]
    chunk.write_bytes(b"invalid")
    with pytest.raises(BackupError):
        reader.verify()
    chunk.unlink()
    with pytest.raises(BackupError):
        reader.verify()


def test_cross_backup_ciphertext_cannot_be_substituted(tmp_path: Path):
    first, second = tmp_path / "first", tmp_path / "second"
    key, _ = create_fixture(first)
    writer = BackupWriter(second, key)
    writer.add("objects/assets/fixture/preview.webp", io.BytesIO(b"unrelated"))
    writer.finish({})
    a, b = BackupReader(first, key), BackupReader(second, key)
    a.manifest["files"][0]["chunks"] = b.manifest["files"][0]["chunks"]
    chunk = b.manifest["files"][0]["chunks"][0]
    target = first / chunk["path"]
    target.write_bytes((second / chunk["path"]).read_bytes())
    with pytest.raises(BackupError):
        a.verify()


def test_existing_backup_and_duplicate_entries_are_rejected(tmp_path: Path):
    writer = BackupWriter(tmp_path / "backup", os.urandom(32))
    writer.add("postgres.dump", io.BytesIO(b"db"))
    with pytest.raises(BackupError):
        writer.add("postgres.dump", io.BytesIO(b"db"))
    with pytest.raises(BackupError):
        BackupWriter(tmp_path / "backup", os.urandom(32))


def test_traversal_or_symlink_in_backup_is_rejected(tmp_path: Path):
    directory = tmp_path / "backup"
    key, _ = create_fixture(directory)
    reader = BackupReader(directory, key)
    reader.manifest["files"][0]["chunks"][0]["path"] = "../outside"
    with pytest.raises((BackupError, AppError)):
        reader.verify()
    link = tmp_path / "link"
    link.symlink_to(directory, target_is_directory=True)
    with pytest.raises(BackupError):
        BackupReader(link, key)


def test_key_requires_32_bytes_and_private_permissions(tmp_path: Path):
    path = tmp_path / "key"
    path.write_text(base64.b64encode(os.urandom(32)).decode())
    path.chmod(0o600)
    assert len(load_key(path)) == 32
    path.chmod(0o644)
    with pytest.raises(BackupError):
        load_key(path)
    path.chmod(0o600)
    path.write_text("not base64")
    with pytest.raises(BackupError):
        load_key(path)


def test_pg_tools_receive_credentials_through_environment_not_argv():
    environment = postgres_environment(
        "postgresql+asyncpg://user:secret@localhost:5433/db?ssl=require&channel_binding=require"
    )
    assert environment["PGPASSWORD"] == "secret"
    assert environment["PGSSLMODE"] == "require"
    assert environment["PGPORT"] == "5433"
    assert environment["PGCHANNELBINDING"] == "require"
    assert "ICLOUD_ACCOUNT" not in environment


def test_verify_cli_emits_matching_content_receipt_without_private_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    from photointel.services.backup import main

    directory = tmp_path / "backup"
    key, _ = create_fixture(directory)
    key_path = tmp_path / "key"
    key_path.write_bytes(base64.b64encode(key))
    key_path.chmod(0o600)
    receipt_path = directory / "verification.json"
    monkeypatch.setattr(
        "sys.argv",
        [
            "backup",
            "verify",
            "--directory",
            str(directory),
            "--key-file",
            str(key_path),
            "--verification-receipt",
            str(receipt_path),
        ],
    )
    main()
    result = json.loads(capsys.readouterr().out)
    receipt = json.loads(receipt_path.read_text())
    header = json.loads((directory / "backup.json").read_text())
    assert result["status"] == receipt["status"] == "verified"
    assert receipt["verification_kind"] == "authenticated-content-integrity"
    assert receipt["backup_id"] == header["backup_id"]
    assert receipt["manifest_sha256"] == header["manifest_sha256"]
    assert receipt_path.stat().st_mode & 0o077 == 0
    assert "preview.webp" not in receipt_path.read_text()
