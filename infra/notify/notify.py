#!/usr/bin/env python3
"""Notify! GitHub Actions adapter: best-effort per-step pushes + iOS Live Activities.

Never log tokens, URLs containing credentials, response bodies, or request payload
secrets. All network calls are bounded and NEVER change the CI job's outcome.
Configure NOTIFY_DEVICE_ID and NOTIFY_TOKEN as repository Actions secrets.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE_URL = "https://push.getnotifyapp.com"
DEVICE_PATTERN = re.compile(r"[A-Za-z0-9_-]{6,40}")
ACTIVITY_PATTERN = re.compile(r"LA[A-Za-z0-9]{6,20}")


def credentials() -> tuple[str, str] | None:
    device = os.environ.get("NOTIFY_DEVICE_ID", "").strip()
    token = os.environ.get("NOTIFY_TOKEN", "").strip()
    if not device or not token:
        print("🔕 Notify! disabled: set NOTIFY_DEVICE_ID and NOTIFY_TOKEN repository secrets.")
        return None
    if not DEVICE_PATTERN.fullmatch(device) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", token):
        print("::warning::Notify! credentials have an unexpected format; skipping.", file=sys.stderr)
        return None
    return device, token


def send(endpoint: str, device: str, token: str, payload: dict, *, extra: dict | None = None, method: str = "POST") -> dict:
    path_id = urllib.parse.quote(device, safe="")
    query = urllib.parse.urlencode({"token": token, **(extra or {})})
    target = f"{BASE_URL}/{endpoint}/{path_id}?{query}"
    request = urllib.request.Request(
        target, method=method,
        headers={"Content-Type": "application/json", "User-Agent": "photointel-github-actions/1"},
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    )
    # Never echo Request/HTTPError objects: they include the token-bearing URL.
    with urllib.request.urlopen(request, timeout=7) as response:
        data = response.read(4096)
    result = json.loads(data)
    if not isinstance(result, dict) or result.get("success") is not True:
        raise ValueError("Notify! did not confirm delivery")
    return result


def clean_label(label: str, max_len: int) -> str:
    return re.sub(r"[\r\n\x00-\x1f]", " ", label).strip()[:max_len]


def activity_progress(value: str) -> int:
    try:
        return max(0, min(100, int(value)))
    except (TypeError, ValueError):
        return 0


def append_output(value: str) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with Path(output_path).open("a", encoding="utf-8") as output:
            output.write(f"activity_id={value}\n")


def short_workflow(name: str) -> str:
    """Small title for Lock Screen, Dynamic Island and grouped pushes."""
    label = name.casefold()
    if "bootstrap" in label and "gcp" in label:
        return "PhotoIntel · Setup"
    if "deploy" in label or "release" in label:
        return "PhotoIntel · Deploy"
    for token, pretty in (
        ("validate", "Validação"), ("ci", "CI"), ("test", "Testes"),
        ("pages", "Pages"), ("webkit", "WebKit"), ("zip", "ZIP"),
        ("ssh", "SSH"), ("manifest", "Manifesto"),
    ):
        if token in label:
            return f"PhotoIntel · {pretty}"
    return "PhotoIntel · CI"


def short_step(name: str) -> str:
    """Compress verbose YAML step labels before sending to the iPhone."""
    source = re.sub(r"\[[^\]]{1,32}\]", "", name)
    source = re.sub(r"^[\W_]+", "", source, flags=re.UNICODE).strip()
    known = (
        ("checkout", "Código"), ("source", "Código"), ("authenticate", "Login"),
        ("auth", "Login"), ("gcloud", "Google Cloud"), ("configure", "Config"),
        ("prepare", "Config"), ("preflight", "Verificação"), ("prerequisites", "Verificação"),
        ("compile", "Build"), ("build", "Build"), ("image", "Imagem"),
        ("migration", "Neon"), ("migrate", "Neon"), ("neon", "Neon"),
        ("scheduler", "Agenda"), ("cleanup", "Limpeza"),
        ("publish", "Publicação"), ("deploy", "Publicação"),
        ("test", "Testes"), ("validation", "Validação"),
    )
    lowered = name.casefold()
    for key, pretty in known:
        if key in lowered:
            return pretty
    return clean_label(source or name, 26)


def handle(args: argparse.Namespace, device: str, token: str) -> None:
    workflow = short_workflow(args.workflow)
    run_id = clean_label(os.environ.get("GITHUB_RUN_ID", ""), 32)
    repository = clean_label(os.environ.get("GITHUB_REPOSITORY", ""), 100)
    run_url = f"https://github.com/{repository}/actions/runs/{run_id}" if repository and run_id else ""
    if args.action == "start":
        payload = {
            "title": workflow,
            "body": "Iniciando…",
            "symbol": "hammer.fill",
            "tint": "#3B82F6",
            "progress": 0,
            "status": "running",
            "endsIn": 5400,
        }
        if run_url:
            payload["button"] = {"title": "GitHub", "url": run_url, "open": True}
        result = send("live-activity", device, token, payload, extra={"new": "1"})
        activity_id = result.get("activityId", "")
        if not isinstance(activity_id, str) or not ACTIVITY_PATTERN.fullmatch(activity_id):
            raise ValueError("Notify! did not return a valid activity ID")
        append_output(activity_id)
        print("📱 Live Activity started.")
        return

    if args.action == "step":
        outcome = args.outcome.lower().strip()
        if outcome not in {"success", "failure", "cancelled"}:
            return
        label = short_step(args.step)
        failed = outcome in {"failure", "cancelled"}
        live = bool(args.activity_id and ACTIVITY_PATTERN.fullmatch(args.activity_id))
        # No push for every successful step. The Live Activity quietly updates,
        # and failures receive an actionable push. Non-GCP CI only pushes errors.
        if failed:
            text = f"❌ {label} falhou" if outcome == "failure" else f"⚠️ {label} cancelado"
            send("notify-json", device, token, {
                "title": workflow,
                "text": text,
                "groupType": f"photointel-{run_id or 'actions'}",
            })
            print(f"🔔 {text}")
        if live:
            send("live-activity", args.activity_id, token, {
                "progress": activity_progress(args.progress),
                "body": ("❌ " if failed else "") + label,
                "status": "failed" if failed else "running",
            })
        return

    if args.action == "end":
        success = args.outcome.lower().strip() == "success"
        result = "✅ Concluído" if success else "❌ Falhou"
        # Failure already generated a push in its observed step. Send only the
        # successful final push to avoid duplicate alerts for the same failure.
        if success:
            try:
                send("notify-json", device, token, {
                    "title": workflow,
                    "text": result,
                    "groupType": f"photointel-{run_id or 'actions'}",
                })
            except (OSError, urllib.error.URLError, TimeoutError, ValueError, TypeError):
                print("::warning::Final push unavailable; continuing Live Activity cleanup.")
        if not args.activity_id or not ACTIVITY_PATTERN.fullmatch(args.activity_id):
            return
        payload = {
            "status": "done" if success else "failed",
            "body": result,
            "endsIn": None,
            "keepFor": 60,
        }
        if success:
            payload["progress"] = 100
        send("live-activity", args.activity_id, token, payload, method="DELETE")
        print("📱 Live Activity finished.")
        return


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("start", "step", "end"), required=True)
    parser.add_argument("--workflow", default="")
    parser.add_argument("--job", default="")
    parser.add_argument("--step", default="")
    parser.add_argument("--outcome", default="")
    parser.add_argument("--activity-id", default="")
    parser.add_argument("--progress", default="0")
    args = parser.parse_args()
    creds = credentials()
    if not creds:
        if args.action == "start":
            append_output("")
        return 0
    try:
        handle(args, *creds)
    except (urllib.error.URLError, OSError, TimeoutError, ValueError, TypeError, json.JSONDecodeError) as exc:
        # The response/error object can contain the credential-bearing URL.
        print(f"::warning::Notify! {args.action} was not delivered ({type(exc).__name__}); CI continues.")
        if args.action == "start":
            append_output("")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
