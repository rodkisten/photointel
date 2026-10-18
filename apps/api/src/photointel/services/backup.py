"""Encrypted portable PostgreSQL + private object-content backup and guarded restore.

Each content chunk has an independent authenticated nonce. An encrypted manifest
binds every logical file to its size, SHA-256 and ordered ciphertext chunks. This is
an actual second copy of bytes, independent of the original object-store bucket.
"""

import argparse
import base64
import hashlib
import io
import json
import os
import re
import subprocess
import tempfile
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any
from uuid import uuid4

import psycopg
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg import sql
from sqlalchemy.engine import make_url

from photointel.config import Settings, get_settings
from photointel.errors import AppError
from photointel.storage import Storage, get_storage, validate_key

FORMAT = "photointel-application-backup-v2"
CHUNK_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_BYTES = 256 * 1024 * 1024


class BackupError(ValueError):
    """A safe diagnostic without credentials, object payloads or PostgreSQL output."""


def load_key(path: Path) -> bytes:
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise BackupError("A chave deve ser um arquivo privado 0600, sem symlink")
    try:
        key = base64.b64decode(path.read_text().strip(), validate=True)
    except (ValueError, OSError):
        raise BackupError("Chave de backup inválida") from None
    if len(key) != 32:
        raise BackupError("A chave de backup deve conter 32 bytes em base64")
    return key


def _json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()


class BackupWriter:
    def __init__(self, directory: Path, key: bytes, key_id: str = "v1") -> None:
        if directory.exists():
            raise BackupError("Escolha um diretório de backup novo")
        directory.mkdir(parents=True, mode=0o700)
        os.chmod(directory, 0o700)
        self.directory, self.key, self.key_id = directory, key, key_id
        self.backup_id = uuid4().hex
        self.entries: list[dict[str, Any]] = []
        (directory / "chunks").mkdir(mode=0o700)

    def _write(self, name: str, data: bytes) -> None:
        with (self.directory / name).open("xb") as handle:
            os.chmod(handle.name, 0o600)
            handle.write(data)

    def add(
        self, name: str, stream: IO[bytes], *, metadata: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        validate_key(name)
        if any(entry["name"] == name for entry in self.entries):
            raise BackupError("Entrada de backup duplicada")
        chunks: list[dict[str, str]] = []
        size, digest = 0, hashlib.sha256()
        while True:
            piece = stream.read(CHUNK_BYTES)
            if not piece:
                break
            size += len(piece)
            digest.update(piece)
            nonce = os.urandom(12)
            aad = _json([FORMAT, self.backup_id, name, len(chunks)])
            encrypted = nonce + AESGCM(self.key).encrypt(nonce, piece, aad)
            relative = f"chunks/{uuid4().hex}.enc"
            self._write(relative, encrypted)
            chunks.append(
                {"path": relative, "sha256": hashlib.sha256(encrypted).hexdigest()}
            )
        entry = {
            "name": name,
            "bytes": size,
            "sha256": digest.hexdigest(),
            "chunks": chunks,
            "metadata": metadata or {},
        }
        self.entries.append(entry)
        return entry

    def finish(self, metadata: dict[str, Any]) -> dict[str, Any]:
        manifest = {
            "format": FORMAT,
            "backup_id": self.backup_id,
            "created_at": datetime.now(UTC).isoformat(),
            "object_content_included": True,
            "files": self.entries,
            **metadata,
        }
        nonce = os.urandom(12)
        payload = _json(manifest)
        if len(payload) > MAX_MANIFEST_BYTES:
            raise BackupError("Manifesto excede o limite; particione o backup")
        aad = _json([FORMAT, self.backup_id, self.key_id, "manifest"])
        encrypted = nonce + AESGCM(self.key).encrypt(nonce, payload, aad)
        self._write("manifest.enc", encrypted)
        header = {
            "format": FORMAT,
            "backup_id": self.backup_id,
            "key_id": self.key_id,
            "manifest_sha256": hashlib.sha256(encrypted).hexdigest(),
        }
        self._write("backup.json", _json(header))
        return manifest


class BackupReader:
    def __init__(self, directory: Path, key: bytes) -> None:
        self.directory, self.key = directory.resolve(), key
        if directory.is_symlink():
            raise BackupError("Diretório de backup não pode ser symlink")
        try:
            header = json.loads(self._read("backup.json", 4096))
            if header["format"] != FORMAT:
                raise BackupError("Formato de backup incompatível")
            payload = self._read("manifest.enc", MAX_MANIFEST_BYTES + 28)
            if hashlib.sha256(payload).hexdigest() != header["manifest_sha256"]:
                raise BackupError("Checksum do manifesto inválido")
            aad = _json([FORMAT, header["backup_id"], header["key_id"], "manifest"])
            manifest = json.loads(AESGCM(key).decrypt(payload[:12], payload[12:], aad))
            if (
                manifest["backup_id"] != header["backup_id"]
                or manifest["format"] != FORMAT
            ):
                raise BackupError("Manifesto de outro backup")
            self.manifest, self.backup_id = manifest, header["backup_id"]
            names = [entry["name"] for entry in manifest["files"]]
            if len(names) != len(set(names)):
                raise BackupError("Entradas de backup duplicadas")
        except (KeyError, ValueError, TypeError, InvalidTag, OSError) as exc:
            raise BackupError(
                "Backup inválido, corrompido ou chave incompatível"
            ) from exc

    def _read(self, relative: str, limit: int) -> bytes:
        validate_key(relative)
        path = self.directory / relative
        if path.is_symlink() or not path.resolve().is_relative_to(self.directory):
            raise BackupError("Caminho inseguro no backup")
        with path.open("rb") as handle:
            payload = handle.read(limit + 1)
        if len(payload) > limit:
            raise BackupError("Arquivo de backup excede limite")
        return payload

    def chunks(self, entry: dict[str, Any]) -> Iterator[bytes]:
        digest, size = hashlib.sha256(), 0
        validate_key(entry["name"])
        try:
            for index, chunk in enumerate(entry["chunks"]):
                payload = self._read(chunk["path"], CHUNK_BYTES + 28)
                if hashlib.sha256(payload).hexdigest() != chunk["sha256"]:
                    raise BackupError("Checksum de conteúdo criptografado inválido")
                aad = _json([FORMAT, self.backup_id, entry["name"], index])
                piece = AESGCM(self.key).decrypt(payload[:12], payload[12:], aad)
                size += len(piece)
                digest.update(piece)
                yield piece
            if size != entry["bytes"] or digest.hexdigest() != entry["sha256"]:
                raise BackupError("Checksum de conteúdo restaurado inválido")
        except (KeyError, TypeError, InvalidTag, OSError) as exc:
            raise BackupError("Conteúdo de backup corrompido") from exc

    def verify(self) -> dict[str, int]:
        count = size = 0
        for entry in self.manifest["files"]:
            for piece in self.chunks(entry):
                size += len(piece)
            count += 1
        return {"files_verified": count, "bytes_verified": size}


def postgres_environment(url: str) -> dict[str, str]:
    parsed = make_url(url)
    if not parsed.drivername.startswith("postgresql") or not parsed.database:
        raise BackupError("Configure uma conexão PostgreSQL válida")
    environment = {"PATH": os.environ.get("PATH", ""), "PGCONNECT_TIMEOUT": "15"}
    for key, value in {
        "PGHOST": parsed.host,
        "PGPORT": str(parsed.port or 5432),
        "PGUSER": parsed.username,
        "PGPASSWORD": parsed.password,
        "PGDATABASE": parsed.database,
    }.items():
        if value is not None:
            environment[key] = value
    environment["PGSSLMODE"] = str(
        parsed.query.get("sslmode", parsed.query.get("ssl", "prefer"))
    )
    return environment


def postgres_url(url: str) -> str:
    parsed = make_url(url).set(drivername="postgresql")
    query = dict(parsed.query)
    if "ssl" in query:
        query["sslmode"] = query.pop("ssl")
    return parsed.set(query=query).render_as_string(hide_password=False)


def _fingerprints(connection: psycopg.Connection) -> dict[str, Any]:
    """Order-independent SQL digest; private row payloads remain in PostgreSQL."""
    tables = connection.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    ).fetchall()
    result = {}
    for (name,) in tables:
        row = connection.execute(
            sql.SQL(
                "SELECT count(*), coalesce(md5(string_agg(digest, '' ORDER BY digest)), "
                "md5('')) "
                "FROM (SELECT md5(row_to_json(t)::text) digest FROM {} t) hashed"
            ).format(sql.Identifier("public", name))
        ).fetchone()
        assert row is not None
        result[name] = {"rows": row[0], "digest": row[1]}
    return result


def create_backup(
    settings: Settings,
    output: Path,
    key: bytes,
    key_id: str = "v1",
    *,
    storage: Storage | None = None,
) -> dict[str, Any]:
    storage = storage or get_storage()
    writer = BackupWriter(output, key, key_id)
    url = settings.migration_database_url or settings.database_url
    environment = postgres_environment(url)
    object_count = 0
    # Export one consistent DB snapshot. Spool only object references into a 0600
    # ephemeral file; close the read-only DB transaction before all R2 transfers.
    with tempfile.TemporaryDirectory(prefix="photointel-backup-") as temporary:
        references = Path(temporary) / "references.jsonl"
        with psycopg.connect(postgres_url(url)) as connection:
            connection.execute(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
            )
            snapshot_row = connection.execute("SELECT pg_export_snapshot()").fetchone()
            assert snapshot_row is not None
            snapshot = snapshot_row[0]
            head = connection.execute(
                "SELECT version_num FROM alembic_version"
            ).fetchall()
            fingerprints = _fingerprints(connection)
            with references.open("x") as handle:
                os.chmod(references, 0o600)
                with connection.cursor(name="backup_resources") as cursor:
                    cursor.execute(
                        "SELECT object_key, mime_type, sha256, byte_size "
                        "FROM asset_resources WHERE object_key IS NOT NULL "
                        "AND status IN ('ready','available','completed') "
                        "AND resource_type <> 'inference_input' ORDER BY object_key"
                    )
                    for row in cursor:
                        handle.write(
                            json.dumps(
                                {
                                    "key": row[0],
                                    "mime": row[1],
                                    "sha256": row[2],
                                    "bytes": row[3],
                                }
                            )
                            + "\n"
                        )
                session_row = connection.execute(
                    "SELECT to_regclass('public.icloud_session_states')"
                ).fetchone()
                assert session_row is not None
                session_table = session_row[0]
                if session_table:
                    session_rows = connection.execute(
                        "SELECT object_key, ciphertext_sha256 "
                        "FROM icloud_session_states "
                        "WHERE object_key IS NOT NULL AND revoked_at IS NULL"
                    )
                    for row in session_rows:
                        handle.write(
                            json.dumps(
                                {
                                    "key": row[0],
                                    "mime": "application/octet-stream",
                                    "sha256": row[1],
                                    "bytes": None,
                                }
                            )
                            + "\n"
                        )
            command = [
                "pg_dump",
                "--format=custom",
                "--no-owner",
                "--no-acl",
                "--snapshot",
                snapshot,
            ]
            with subprocess.Popen(
                command,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            ) as process:
                assert process.stdout is not None
                try:
                    writer.add("postgres.dump", process.stdout)
                except BaseException:
                    process.terminate()
                    raise
                if process.wait() != 0:
                    raise BackupError("pg_dump falhou; backup não finalizado")
            for table in (
                "tags",
                "tag_aliases",
                "model_registry",
                "albums",
                "bridge_devices",
            ):
                # The dump is authoritative; these bounded exports improve portability.
                count = fingerprints.get(table, {}).get("rows", 0)
                if count > 100000:
                    continue
                rows = connection.execute(
                    sql.SQL("SELECT row_to_json(t) FROM {} t").format(
                        sql.Identifier(table)
                    )
                ).fetchall()
                # Bridge credentials/hashes are retained only in the encrypted DB dump.
                if table == "bridge_devices":
                    continue
                writer.add(
                    f"metadata/{table}.json", io.BytesIO(_json([row[0] for row in rows]))
                )
        seen = set()
        with references.open() as handle:
            for line in handle:
                reference = json.loads(line)
                object_key = validate_key(reference["key"])
                if object_key in seen:
                    continue
                seen.add(object_key)
                payload = storage.get(object_key)
                digest = hashlib.sha256(payload).hexdigest()
                if reference["sha256"] and digest != reference["sha256"]:
                    raise BackupError("Objeto privado diverge do checksum no catálogo")
                if reference["bytes"] is not None and len(payload) != reference["bytes"]:
                    raise BackupError("Objeto privado incompleto")
                writer.add(
                    f"objects/{object_key}",
                    io.BytesIO(payload),
                    metadata={"object_key": object_key, "mime": reference["mime"]},
                )
                object_count += 1
    safe_configuration = {
        name: getattr(settings, name)
        for name in (
            "app_env",
            "storage_backend",
            "siglip_model_id",
            "siglip_model_revision",
            "joytag_model_id",
            "joytag_model_revision",
            "siglip_embedding_dimension",
            "download_representation",
            "sensitive_tags_visible",
        )
    }
    return writer.finish(
        {
            "migration_heads": [row[0] for row in head],
            "database_fingerprints": fingerprints,
            "object_count": object_count,
            "configuration_without_secrets": safe_configuration,
            "includes_original_icloud_photographs": False,
        }
    )


def restore_backup(
    reader: BackupReader,
    target_url: str,
    storage: Storage,
    *,
    confirm_database: str,
    allow_production: bool = False,
) -> dict[str, Any]:
    """Restore only an empty, explicitly named target; no DROP/CLEAN operations."""
    parsed = make_url(target_url)
    if parsed.database != confirm_database:
        raise BackupError("Confirme o nome exato do banco de destino")
    if not allow_production and not re.fullmatch(
        r"pi_restore_[a-z0-9_]{1,80}", confirm_database
    ):
        raise BackupError(
            "Use banco isolado pi_restore_* ou aprovação explícita de produção"
        )
    # Verify all encrypted content before touching the destination.
    verified = reader.verify()
    with psycopg.connect(postgres_url(target_url)) as connection:
        count_row = connection.execute(
            "SELECT count(*) FROM pg_tables WHERE schemaname='public'"
        ).fetchone()
        assert count_row is not None
        count = count_row[0]
        if (
            count
            and _fingerprints(connection) != reader.manifest["database_fingerprints"]
        ):
            raise BackupError(
                "O banco de destino deve estar vazio ou corresponder a este backup"
            )
    dumps = [
        entry for entry in reader.manifest["files"] if entry["name"] == "postgres.dump"
    ]
    if len(dumps) != 1:
        raise BackupError("Backup deve conter exatamente um dump PostgreSQL")
    if not count:
        with subprocess.Popen(
            [
                "pg_restore",
                "--no-owner",
                "--no-acl",
                "--exit-on-error",
                "--dbname",
                confirm_database,
            ],
            env=postgres_environment(target_url),
            stdin=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        ) as process:
            assert process.stdin is not None
            try:
                for piece in reader.chunks(dumps[0]):
                    process.stdin.write(piece)
                process.stdin.close()
            except BaseException:
                process.terminate()
                raise
            if process.wait() != 0:
                raise BackupError("pg_restore falhou; revise o destino isolado")
    restored = 0
    for entry in reader.manifest["files"]:
        if not entry["name"].startswith("objects/"):
            continue
        object_key = validate_key(entry["metadata"]["object_key"])
        # Media inputs are capped by the existing storage adapter; backup is chunked.
        content = b"".join(reader.chunks(entry))
        if storage.exists(object_key):
            if hashlib.sha256(storage.get(object_key)).hexdigest() != entry["sha256"]:
                raise BackupError("Objeto divergente no destino; substituição bloqueada")
        else:
            storage.put(
                object_key,
                content,
                entry["metadata"].get("mime") or "application/octet-stream",
            )
        if hashlib.sha256(storage.get(object_key)).hexdigest() != entry["sha256"]:
            raise BackupError("Verificação de leitura do objeto restaurado falhou")
        restored += 1
    with psycopg.connect(postgres_url(target_url)) as connection:
        heads = [
            row[0]
            for row in connection.execute("SELECT version_num FROM alembic_version")
        ]
        if sorted(heads) != sorted(reader.manifest["migration_heads"]):
            raise BackupError("Revisões de migração divergentes após restore")
        if _fingerprints(connection) != reader.manifest["database_fingerprints"]:
            raise BackupError("O banco restaurado diverge do backup")
    return {
        **verified,
        "objects_restored_and_read_back": restored,
        "database_fingerprints_match": True,
        "migration_heads": heads,
        "status": "passed",
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backup criptografado de PostgreSQL e conteúdo R2"
    )
    parser.add_argument("command", choices=("create", "verify", "restore"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--key-id", default="v1")
    parser.add_argument("--confirm-database", default="")
    parser.add_argument("--allow-production-target", action="store_true")
    parser.add_argument("--verification-receipt", type=Path)
    arguments = parser.parse_args()
    try:
        key = load_key(arguments.key_file)
        if arguments.command == "create":
            manifest = create_backup(
                get_settings(), arguments.directory, key, arguments.key_id
            )
            result = {
                "status": "created",
                "object_content_included": True,
                "files": len(manifest["files"]),
                "object_count": manifest["object_count"],
            }
        else:
            reader = BackupReader(arguments.directory, key)
            if arguments.command == "verify":
                result = {"status": "verified", **reader.verify()}
            else:
                settings = get_settings()
                result = restore_backup(
                    reader,
                    settings.migration_database_url or settings.database_url,
                    get_storage(),
                    confirm_database=arguments.confirm_database,
                    allow_production=arguments.allow_production_target,
                )
        if arguments.verification_receipt:
            if arguments.command == "create":
                raise BackupError("Execute verify ou restore antes de emitir um recibo")
            header = json.loads((arguments.directory / "backup.json").read_text())
            receipt = {
                **result,
                "backup_id": header["backup_id"],
                "manifest_sha256": header["manifest_sha256"],
                "verified_at": datetime.now(UTC).isoformat(),
                "verification_kind": (
                    "database-and-object-restore"
                    if arguments.command == "restore"
                    else "authenticated-content-integrity"
                ),
            }
            with arguments.verification_receipt.open("x") as handle:
                os.chmod(handle.name, 0o600)
                json.dump(receipt, handle, indent=2)
        print(json.dumps(result))
    except (BackupError, AppError, OSError, psycopg.Error) as exc:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "exception_type": type(exc).__name__,
                    "message": str(exc)
                    if isinstance(exc, BackupError)
                    else "Falha segura; verifique configuração, serviços e permissões",
                }
            )
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
