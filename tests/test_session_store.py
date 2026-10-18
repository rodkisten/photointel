"""Authenticated encryption, bounded extraction, lifecycle and fencing failure tests."""

import base64
import io
import json
import tarfile
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from photointel.config import Settings
from photointel.errors import AppError
from photointel.services.session_store import (
    SessionLease,
    decrypt_snapshot,
    encrypt_snapshot,
    pack_directory,
    session_directory,
    session_scope,
    unpack_directory,
)
from photointel.storage import LocalStorage


def settings(tmp_path: Path) -> Settings:
    return Settings(
        app_env="test",
        icloud_account="fixture@invalid.test",
        icloud_library="PrimarySync",
        icloud_session_backend="encrypted_object",
        icloud_session_key=base64.b64encode(b"k" * 32).decode(),
        icloud_session_directory=tmp_path / "local",
    )


class Repository:
    def __init__(self, configuration: Settings):
        self.lease = SessionLease(
            session_scope(configuration),
            uuid4(),
            1,
            0,
            None,
            None,
            None,
            datetime.now(UTC),
        )
        self.active = False
        self.published = 0
        self.expired = False

    async def claim(self):
        if self.active:
            raise AppError("RATE_LIMITED", "Already owned")
        self.active = True
        return self.lease

    async def heartbeat(self, lease):
        return not self.expired

    async def publish(self, lease, key, digest):
        if self.expired:
            raise AppError("SYNC_CONFLICT", "Lease expired")
        self.published += 1
        self.lease = replace(
            lease,
            object_key=key,
            sha256=digest,
            generation=lease.generation + 1,
            key_id="v1",
        )

    async def release(self, lease):
        self.active = False


def test_snapshot_binds_account_library_generation_key_and_detects_corruption():
    key = b"k" * 32
    encrypted = encrypt_snapshot(b"private cookie", key, "scope", 1, "v1")
    assert decrypt_snapshot(encrypted, key, "scope", 1, "v1", 1024) == b"private cookie"
    assert b"private cookie" not in encrypted
    assert encrypted != encrypt_snapshot(b"private cookie", key, "scope", 1, "v1")
    for scope, generation, key_id, wrong_key in (
        ("other", 1, "v1", key),
        ("scope", 2, "v1", key),
        ("scope", 1, "v2", key),
        ("scope", 1, "v1", b"x" * 32),
    ):
        with pytest.raises(AppError):
            decrypt_snapshot(encrypted, wrong_key, scope, generation, key_id, 1024)
    envelope = json.loads(encrypted)
    envelope["ciphertext"] = base64.b64encode(b"corrupt").decode()
    with pytest.raises(AppError):
        decrypt_snapshot(json.dumps(envelope).encode(), key, "scope", 1, "v1", 1024)


def test_regular_session_files_roundtrip_private_permissions(tmp_path: Path):
    source, target = tmp_path / "source", tmp_path / "target"
    source.mkdir()
    (source / "nested").mkdir()
    (source / "nested/cookies").write_bytes(b"synthetic cookies")
    payload = pack_directory(source, 1024)
    unpack_directory(payload, target, 1024)
    assert (target / "nested/cookies").read_bytes() == b"synthetic cookies"
    assert target.stat().st_mode & 0o077 == 0
    assert (target / "nested").stat().st_mode & 0o077 == 0
    assert (target / "nested/cookies").stat().st_mode & 0o077 == 0


@pytest.mark.parametrize(
    "name,type_",
    [
        ("../outside", tarfile.REGTYPE),
        ("/outside", tarfile.REGTYPE),
        ("a", tarfile.SYMTYPE),
        ("a", tarfile.LNKTYPE),
        ("a", tarfile.FIFOTYPE),
        ("a\\b", tarfile.REGTYPE),
    ],
)
def test_archive_traversal_and_special_files_are_blocked(tmp_path: Path, name, type_):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        info = tarfile.TarInfo(name)
        info.type = type_
        info.size = 0
        archive.addfile(info)
    with pytest.raises(AppError):
        unpack_directory(stream.getvalue(), tmp_path / "out", 1024)
    assert not (tmp_path / "outside").exists()


def test_symlinks_oversize_and_empty_session_are_blocked(tmp_path: Path):
    source = tmp_path / "source"
    source.mkdir()
    with pytest.raises(AppError):
        pack_directory(source, 1024)
    (source / "cookie").write_bytes(b"x" * 2048)
    with pytest.raises(AppError):
        pack_directory(source, 1024)
    (source / "cookie").unlink()
    (source / "cookie").symlink_to(tmp_path / "secret")
    with pytest.raises(AppError):
        pack_directory(source, 1024)


async def test_bootstrap_rehydrate_refresh_and_plaintext_cleanup(tmp_path: Path):
    configuration = settings(tmp_path)
    repository = Repository(configuration)
    storage = LocalStorage(tmp_path / "objects")
    async with session_directory(
        configuration, require_existing=False, repository=repository, storage=storage
    ) as directory:
        assert directory.stat().st_mode & 0o077 == 0
        (directory / "cookie").write_text("first cookie")
    assert not directory.exists()
    assert repository.published == 1
    async with session_directory(
        configuration, repository=repository, storage=storage
    ) as directory:
        assert (directory / "cookie").read_text() == "first cookie"
        (directory / "cookie").write_text("refreshed")
    assert not directory.exists()
    assert repository.published == 2
    async with session_directory(
        configuration, repository=repository, storage=storage
    ) as directory:
        assert (directory / "cookie").read_text() == "refreshed"
    assert repository.published == 2  # Unchanged cookies do not create new R2 objects.


async def test_missing_expired_corrupt_and_reauth_bootstrap(tmp_path: Path):
    configuration = settings(tmp_path)
    repository = Repository(configuration)
    storage = LocalStorage(tmp_path / "objects")
    with pytest.raises(AppError):
        async with session_directory(
            configuration, repository=repository, storage=storage
        ):
            pytest.fail("Missing session must not reach Apple")
    assert not repository.active
    async with session_directory(
        configuration, require_existing=False, repository=repository, storage=storage
    ) as directory:
        (directory / "cookie").write_text("fixture")
    repository.lease = replace(
        repository.lease, updated_at=datetime.now(UTC) - timedelta(days=60)
    )
    with pytest.raises(AppError):
        async with session_directory(
            configuration, repository=repository, storage=storage
        ):
            pytest.fail("Expired session must require reauthentication")
    # Explicit live-authenticated terminal bootstrap replaces even an expired snapshot.
    async with session_directory(
        configuration, require_existing=False, repository=repository, storage=storage
    ) as directory:
        (directory / "cookie").write_text("new authenticated fixture")
    repository.lease = replace(repository.lease, updated_at=datetime.now(UTC))
    storage.put(repository.lease.object_key, b"corrupt", "application/octet-stream")
    with pytest.raises(AppError):
        async with session_directory(
            configuration, repository=repository, storage=storage
        ):
            pytest.fail("Checksum failure must not expose partial session")


async def test_failure_preserves_snapshot_and_stale_owner_cannot_publish(tmp_path: Path):
    configuration = settings(tmp_path)
    repository = Repository(configuration)
    storage = LocalStorage(tmp_path / "objects")
    with pytest.raises(RuntimeError):
        async with session_directory(
            configuration, require_existing=False, repository=repository, storage=storage
        ) as directory:
            (directory / "cookie").write_text("fixture")
            raise RuntimeError("simulated interrupted network operation")
    assert not directory.exists()
    assert repository.published == 0
    with pytest.raises(AppError):
        async with session_directory(
            configuration, require_existing=False, repository=repository, storage=storage
        ) as directory:
            (directory / "cookie").write_text("fixture")
            repository.expired = True
    assert not directory.exists()
    assert repository.published == 0


async def test_overlapping_session_owners_are_rejected(tmp_path: Path):
    configuration = settings(tmp_path)
    repository = Repository(configuration)
    storage = LocalStorage(tmp_path / "objects")
    async with session_directory(
        configuration, require_existing=False, repository=repository, storage=storage
    ) as directory:
        (directory / "cookie").write_text("fixture")
        with pytest.raises(AppError):
            async with session_directory(
                configuration,
                require_existing=False,
                repository=repository,
                storage=storage,
            ):
                pytest.fail("Concurrent session refresh not permitted")
