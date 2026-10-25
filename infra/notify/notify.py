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
    if ("bootstrap" in label or "setup" in label) and "gcp" in label:
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


REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
RUN_RE = re.compile(r"^[0-9]{1,20}$")


def run_context() -> tuple[str, str, str]:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    run = os.environ.get("GITHUB_RUN_ID", "")
    if not REPO_RE.fullmatch(repo) or not RUN_RE.fullmatch(run):
        return "", "", ""
    return repo, run, f"https://github.com/{repo}/actions/runs/{run}"


def github_step_link(step_name: str, job_key: str, step_index: str = "") -> str:
    """Link to the actual private GitHub Actions job/step, never guess job IDs."""
    repo, run, fallback = run_context()
    token = os.environ.get("GITHUB_API_TOKEN", "")
    if not token or not fallback:
        return fallback
    try:
        request = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/actions/runs/{run}/jobs?per_page=100",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "PhotoIntel-Notify",
            },
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            data = json.load(response)
        jobs = data.get("jobs", [])
        if not isinstance(jobs, list):
            return fallback
        # Single-job deploy/bootstrap is unambiguous. Do not link to a random
        # matrix job when there are multiple entries.
        if len(jobs) == 1:
            job = jobs[0]
        else:
            matching = [
                item for item in jobs
                if job_key.casefold() in str(item.get("name", "")).casefold()
            ]
            if len(matching) != 1:
                return fallback
            job = matching[0]
        job_id = job.get("id")
        if not isinstance(job_id, int) or job_id <= 0:
            return fallback
        url = f"{fallback}/job/{job_id}"
        candidates = [
            step for step in job.get("steps", [])
            if step.get("name") == step_name and isinstance(step.get("number"), int)
        ]
        if len(candidates) == 1:
            return f"{url}#step:{candidates[0]['number']}:1"
        if re.fullmatch(r"[1-9][0-9]{0,2}", step_index):
            return f"{url}#step:{int(step_index)}:1"
        return url
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError, TimeoutError):
        return fallback


def gcp_failure_url(step: str, project: str, region: str) -> str:
    """Only point to GCP when that particular failed phase actually lives there."""
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        return ""
    if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]", region):
        return ""
    normalized = step.casefold()
    base = "https://console.cloud.google.com"
    if "api" in normalized or "cloud run" in normalized:
        return f"{base}/run/detail/{region}/photointel-api/logs?project={project}"
    if "jobs" in normalized or "worker" in normalized:
        return f"{base}/run/jobs?project={project}"
    if "build" in normalized:
        return f"{base}/cloud-build/builds?project={project}"
    return ""


def stage_count(value: str, total: int) -> int:
    try:
        return max(0, min(total, int(value)))
    except (TypeError, ValueError):
        return 0


def steps_visual(total: int, completed: int) -> dict:
    # Notify segmented progress requires 2-20 stages; use standard progress
    # when a single stage is selected, retaining the accurate N/N fraction.
    if 2 <= total <= 20:
        return {"steps": total, "step": completed}
    return {"progress": round(100 * completed / total)}


def link_button(url: str, label: str) -> dict | None:
    if not url.startswith("https://"):
        return None
    return {"title": label, "url": url[:512], "open": True}


def handle(args: argparse.Namespace, device: str, token: str) -> None:
    workflow = short_workflow(args.workflow)
    _, run_id, run_url = run_context()
    total = max(1, min(20, int(getattr(args, "total", "1"))))
    completed = stage_count(getattr(args, "completed", "0"), total)
    fraction = f"{completed}/{total}"
    if args.action == "start":
        payload = {
            "title": workflow,
            "body": f"Preparando · {fraction}",
            "symbol": "square.stack.3d.up.fill",
            "tint": "#3B82F6",
            "trailing": fraction,
            "status": "running",
            **steps_visual(total, completed),
        }
        button = link_button(run_url, "Ver workflow")
        if button:
            payload["button"] = button
        result = send("live-activity", device, token, payload, extra={"new": "1"})
        activity_id = result.get("activityId", "")
        if not isinstance(activity_id, str) or not ACTIVITY_PATTERN.fullmatch(activity_id):
            raise ValueError("Notify! did not return a valid activity ID")
        append_output(activity_id)
        print("📱 Live Activity iniciada.")
        return

    if args.action == "step":
        outcome = args.outcome.lower().strip()
        if outcome not in {"running", "success", "failure", "cancelled"}:
            return
        label = short_step(getattr(args, "label", "") or args.step)
        failed = outcome in {"failure", "cancelled"}
        link = github_step_link(
            args.step, args.job, getattr(args, "step_index", "")
        )
        button_title = "Ver step"
        if failed:
            gcp_url = gcp_failure_url(
                args.step, getattr(args, "project", ""), getattr(args, "region", "")
            )
            if gcp_url:
                link = gcp_url
                button_title = "Logs GCP"
            message = f"❌ {label}" if outcome == "failure" else f"⚠️ {label}"
            send("notify-json", device, token, {
                "title": workflow,
                "text": f"{message} · {fraction}",
                "groupType": f"photointel-{run_id or 'actions'}",
            })
            print(f"🔔 {message}")
        if args.activity_id and ACTIVITY_PATTERN.fullmatch(args.activity_id):
            payload = {
                "body": f"{'❌ ' if failed else ''}{label} · {fraction}",
                "trailing": fraction,
                "status": "failed" if failed else "running",
                **steps_visual(total, completed),
            }
            button = link_button(link, button_title)
            if button:
                payload["button"] = button
            send("live-activity", args.activity_id, token, payload)
        return

    if args.action == "end":
        success = args.outcome.lower().strip() == "success"
        message = "✅ Concluído" if success else "❌ Falhou"
        if success:
            # One final push, no per-step success noise.
            try:
                send("notify-json", device, token, {
                    "title": workflow, "text": f"{message} · {total}/{total}",
                    "groupType": f"photointel-{run_id or 'actions'}",
                })
            except (urllib.error.URLError, OSError, ValueError, TypeError, TimeoutError):
                print("::warning::Push final indisponível; Live Activity será encerrada.")
        if not args.activity_id or not ACTIVITY_PATTERN.fullmatch(args.activity_id):
            return
        payload = {
            "status": "done" if success else "failed",
            "body": f"{message} · {total}/{total}" if success else message,
            "endsIn": None,
            "keepFor": 60,
        }
        # Preserve the last real completed-step count on failures.
        if success:
            payload.update({"trailing": f"{total}/{total}", **steps_visual(total, total)})
        send("live-activity", args.activity_id, token, payload, method="DELETE")
        print("📱 Live Activity finalizada.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("start", "step", "end"), required=True)
    parser.add_argument("--workflow", default="")
    parser.add_argument("--job", default="")
    parser.add_argument("--step", default="")
    parser.add_argument("--outcome", default="")
    parser.add_argument("--activity-id", default="")
    parser.add_argument("--progress", default="0")
    parser.add_argument("--label", default="")
    parser.add_argument("--step-index", default="")
    parser.add_argument("--completed", default="0")
    parser.add_argument("--total", default="1")
    parser.add_argument("--project", default="")
    parser.add_argument("--region", default="us-central1")
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
