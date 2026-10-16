"""Dependency-free safety checks against actual worker core functions.

Extracts selected source definitions with AST solely because the current execution
machine lacks installed project dependencies. It does not replace Pytest, PostgreSQL,
S3, iCloud, or GPU validation. No network or paid inference is performed.
"""

import ast
import json
import os
import re  # noqa: F401 - used by definitions executed from the actual source
import sys
import tempfile
import threading
import time
from dataclasses import dataclass  # noqa: F401 - source execution context
from datetime import (
    UTC,
    datetime,
    timedelta,  # noqa: F401 - source execution context
)
from enum import StrEnum  # noqa: F401 - source execution context
from hashlib import sha256  # noqa: F401 - source execution context
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from photointel.errors import AppError
    from photointel.services.duplicates import hash_distance
    from photointel.services.identity import revision_hash
    from photointel.services.ingestion import (
        ICloudAdapter,
        authentication_state,
        record_authentication,
    )
    from photointel.services.jobs import retry_delay
    from photointel.services.worker import superseded_reason

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "apps/api/src/photointel"
checks = 0


def definitions(path: Path, names: set[str]) -> None:
    tree = ast.parse(path.read_text())
    nodes = [
        node
        for node in tree.body
        if isinstance(
            node,
            (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef),
        )
        and node.name in names
    ]
    assert len(nodes) == len(names), (path.name, names)
    future = ast.ImportFrom(
        module="__future__",
        names=[ast.alias(name="annotations")],
        level=0,
    )
    program = ast.fix_missing_locations(
        ast.Module(
            body=[future, *nodes],
            type_ignores=[],
        )
    )
    exec(compile(program, str(path), "exec"), globals())


def check(condition: bool, explanation: str) -> None:
    global checks
    if not condition:
        raise AssertionError(explanation)
    checks += 1


class Response:
    def __init__(
        self,
        chunks: list[bytes],
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status_code, self.headers = status, headers or {}
        self.chunks, self.read = chunks, False

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError("Controlled transport failure")

    def iter_content(self, chunk_size: int) -> list[bytes]:
        self.read = True
        return self.chunks

    def close(self) -> None:
        pass


def expect_download_failure(adapter: Any, response: Response, target: Path) -> None:
    photo = SimpleNamespace(download=lambda *args, **kwargs: response)
    try:
        adapter.download(
            photo,
            SimpleNamespace(size=6, url="https://fixture.invalid"),
            target,
        )
    except AppError:
        check(True, "Controlled failure")
    else:
        raise AssertionError("Invalid download was accepted")


def threaded_descriptor_check(adapter: Any) -> None:
    # Only the controlled test transport is substituted; describe() is actual source.
    package = ModuleType("pyicloud_ipd")
    package.__path__ = []
    item_type = ModuleType("pyicloud_ipd.item_type")
    item_type.AssetItemType = SimpleNamespace(MOVIE="movie")
    sys.modules["pyicloud_ipd"] = package
    sys.modules["pyicloud_ipd.item_type"] = item_type
    adapter.representation = lambda photo: SimpleNamespace(size=6, checksum="fixture")
    observed_threads: list[int] = []

    class Photo:
        item_type, size, dimensions, versions = "image", 1000, (1024, 768), {}
        added_date = asset_date = datetime(2020, 1, 1, tzinfo=UTC)
        filename = "fixture.jpg"

        @property
        def id(self) -> str:
            observed_threads.append(threading.get_ident())
            time.sleep(0.03)
            return "source-id"

        def calculate_filename(self) -> str:
            return self.filename

    ticks = 0
    result: list[Any] = []
    failures: list[BaseException] = []

    def describe() -> None:
        try:
            result.append(adapter.describe(Photo()))
        except BaseException as exc:
            failures.append(exc)

    thread = threading.Thread(target=describe)
    thread.start()
    while thread.is_alive():
        ticks += 1
        time.sleep(0.002)
    thread.join()
    if failures:
        raise failures[0]
    remote = result[0]
    check(remote.dimensions == (1024, 768), "Downloader dimensions snapshot")
    check(remote.original_size == 1000, "Original size is independent of representation")
    check(
        all(identifier != threading.get_ident() for identifier in observed_threads),
        "Lazy downloader properties stay off the calling thread",
    )
    check(ticks >= 2, "Calling thread remains responsive during blocking adapter work")


def main() -> None:
    definitions(SOURCE / "errors.py", {"ErrorCode", "AppError"})
    definitions(SOURCE / "models.py", {"utcnow"})
    definitions(SOURCE / "services/jobs.py", {"retry_delay"})
    definitions(SOURCE / "services/duplicates.py", {"hash_distance"})
    definitions(SOURCE / "services/identity.py", {"revision_hash"})
    definitions(SOURCE / "services/worker.py", {"superseded_reason"})
    definitions(
        SOURCE / "services/ingestion.py",
        {
            "RemoteAsset",
            "ICloudAdapter",
            "_state_path",
            "authentication_state",
            "record_authentication",
        },
    )
    check(retry_delay(1).total_seconds() == 5, "Initial retry delay")
    check(retry_delay(100).total_seconds() == 3600, "Retry delay is bounded")
    check(hash_distance("0" * 16, "0" * 15 + "3") == 2, "Actual pHash distance")
    check(
        revision_hash({"a": 1, "b": 2}) == revision_hash({"b": 2, "a": 1}),
        "Deterministic metadata revision",
    )
    check(
        superseded_reason({"content_revision": "old"}, "new", "r") is not None,
        "Superseded content skips processing",
    )
    check(
        superseded_reason({"representation_revision": "old"}, "c", "new") is not None,
        "Superseded GPU input skips processing",
    )
    check(
        superseded_reason({}, "current", "current") is None,
        "Explicit current reindex remains possible",
    )
    with tempfile.TemporaryDirectory() as folder:
        directory = Path(folder)
        settings = SimpleNamespace(
            icloud_enabled=True,
            icloud_account="fixture@example.invalid",
            icloud_library="PrimarySync",
            icloud_session_directory=directory / "session",
            max_download_bytes=1024,
        )
        check(authentication_state(settings)["valid"] is False, "No cookie-based success")
        record_authentication(settings, "valid", "Controlled proof")
        check(authentication_state(settings)["valid"] is True, "Recent scoped proof")
        settings.icloud_account = "different@example.invalid"
        check(authentication_state(settings)["valid"] is False, "Proof is account scoped")
        settings.icloud_account = "fixture@example.invalid"
        settings.icloud_library = "OtherLibrary"
        check(authentication_state(settings)["valid"] is False, "Proof is library scoped")
        settings.icloud_library = "PrimarySync"
        check(
            os.stat(settings.icloud_session_directory).st_mode & 0o777 == 0o700,
            "Session directory permissions",
        )
        adapter = ICloudAdapter(settings)
        adapter.client = SimpleNamespace(session=object())
        target = directory / "download.image"
        version = SimpleNamespace(size=6, url="https://fixture.invalid")
        response = Response([b"abc", b"def"])
        photo = SimpleNamespace(download=lambda *args, **kwargs: response)
        check(adapter.download(photo, version, target) == 6, "Bounded complete transfer")
        check(target.read_bytes() == b"abcdef", "Downloaded bytes are preserved")
        check(os.stat(target).st_mode & 0o777 == 0o600, "Download file permissions")
        check(
            adapter.download(photo, version, target) == 0, "No redundant cached download"
        )
        target.unlink()
        partial = target.with_suffix(".part")
        partial.write_bytes(b"abc")
        response = Response([b"def"], 206, {"Content-Range": "bytes 3-5/6"})
        check(adapter.download(photo, version, target) == 3, "Partial download resumes")
        check(target.read_bytes() == b"abcdef", "Resumed content is assembled correctly")
        target.unlink()
        partial.write_bytes(b"abc")
        wrong_range = Response([b"abc"], 206, {"Content-Range": "bytes 0-2/6"})
        expect_download_failure(adapter, wrong_range, target)
        check(
            not wrong_range.read and partial.read_bytes() == b"abc",
            "Wrong ranges are rejected before appending",
        )
        partial.unlink()
        oversized = Response([b"abcdef", b"g"])
        expect_download_failure(adapter, oversized, target)
        check(
            not target.exists() and partial.stat().st_size <= 6,
            "Unexpectedly large stream never becomes a valid representation",
        )
        partial.unlink()
        advertised = Response([], headers={"Content-Length": "2048"})
        expect_download_failure(adapter, advertised, target)
        check(not advertised.read, "Oversized declared payload is never read")
        threaded_descriptor_check(adapter)
    tree = ast.parse((SOURCE / "services/ingestion.py").read_text())
    descriptor_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "to_thread"
        and node.args
        and isinstance(node.args[0], ast.Attribute)
        and node.args[0].attr == "describe"
    ]
    check(
        len(descriptor_calls) == 1,
        "Production ingestion uses threaded descriptor boundary",
    )
    print(
        json.dumps(
            {
                "checks_passed": checks,
                "network_accessed": False,
                "notice": (
                    "Core checks only; Pytest/PostgreSQL/S3/iCloud/GPU remain unverified."
                ),
            }
        )
    )


if __name__ == "__main__":
    main()
