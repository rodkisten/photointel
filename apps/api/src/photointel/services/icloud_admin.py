"""Secure terminal administration; never expose Apple passwords to the web API."""

import argparse
import json
import subprocess
import sys

from photointel.config import get_settings
from photointel.errors import AppError
from photointel.services.ingestion import (
    ICloudAdapter,
    _safe_session_directory,
    authentication_state,
    record_authentication,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Administração segura do iCloud")
    parser.add_argument("command", choices=(
        "authenticate", "verify", "reauthenticate", "libraries",
        "clear", "status", "test",
    ))
    parser.add_argument("--confirm-clear-session", action="store_true")
    args = parser.parse_args()
    settings = get_settings()
    _safe_session_directory(settings)
    if args.command == "clear":
        if not args.confirm_clear_session:
            parser.error(
                "Use --confirm-clear-session para revogar somente a sessão local",
            )
        # The known session directory is dedicated to this service; never accept a path.
        for path in settings.icloud_session_directory.iterdir():
            if path.is_file() and not path.is_symlink():
                path.unlink()
        print(json.dumps({"state": "cleared", "remote_session_revoked": False}))
        return
    if args.command == "status":
        print(json.dumps(authentication_state(settings), ensure_ascii=False))
        return
    if not settings.icloud_account:
        parser.error("Configure ICLOUD_ACCOUNT no servidor")
    if args.command in ("authenticate", "reauthenticate"):
        if not sys.stdin.isatty():
            parser.error("Autenticação requer terminal interativo para senha e 2FA")
        # Exact v1.32.3 flags; password is requested only by the console provider.
        command = ["icloudpd", "--username", settings.icloud_account,
                   "--cookie-directory", str(settings.icloud_session_directory),
                   "--password-provider", "console", "--mfa-provider", "console",
                   "--auth-only"]
        try:
            result = subprocess.run(command, check=False)
        except FileNotFoundError:
            parser.error("Instale icloudpd==1.32.3: uv sync --group ingest")
        finally:
            _safe_session_directory(settings)
        if result.returncode:
            record_authentication(
                settings, "expired", "Login não concluiu; tente novamente no terminal",
            )
            raise SystemExit(result.returncode)
    try:
        adapter = ICloudAdapter(settings)
        libraries = adapter.connect()
        result_json: dict[str, object] = {"state": "valid", "libraries": libraries}
        if args.command == "test":
            photo = next(adapter.assets(), None)
            result_json["asset_accessible"] = photo is not None
            if photo:
                result_json["requested_representation_available"] = (
                    adapter.representation(photo) is not None
                )
        print(json.dumps(result_json, ensure_ascii=False))
    except AppError as exc:
        print(json.dumps({"state": "unavailable", "error_code": exc.code,
                          "message": exc.message}, ensure_ascii=False))
        raise SystemExit(1) from None
    except Exception as exc:
        # Avoid private account data, cookie paths, bearer URLs, or tracebacks.
        record_authentication(
            settings, "unavailable", "Falha ao verificar acesso; verifique rede e sessão",
        )
        print(json.dumps({"state": "unavailable", "error_code": "ICLOUD_ACCESS_DENIED",
                          "exception_type": type(exc).__name__}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
