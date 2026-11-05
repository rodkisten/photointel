#!/usr/bin/env python3
"""Print sanitized VM startup events in GitHub Actions, without Cloud Console.

Only recognized startup-script events are emitted, never raw serial console
content, instance metadata, OAuth responses, tokens or container output.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from datetime import datetime, timedelta, timezone

from infra.gcp.cloud_cli import run as cloud_run

LOG_TIME = re.compile(r"^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})")
SCRIPT_MARKER = 'google_metadata_script_runner'
SAFE_STAGE = re.compile(r"terminal-startup: (?:[a-zA-Z0-9 _.:/@=-]{1,180})")
CURL_HTTP = re.compile(r"curl: \(22\) The requested URL returned error: ([0-9]{3})")
STARTUP_FAILED = re.compile(r'Script "startup-script" failed with error: exit status ([0-9]+)')
READY = re.compile(r"Terminal ready: ssh rod@(?:100\.[0-9.]+|[a-z0-9-]+)\. Maximum uptime: [0-9]+ minutes\.")
APT_WARNING = re.compile(r"(?:W: GPG error:|E: The repository|E: Unable to locate package)")


def gcloud(*args: str) -> str:
    result = cloud_run(args, project='photointel', timeout=20)
    if result.returncode:
        # Never display raw stderr. It can contain provider response context.
        hint = ('Check bootstrap identity permission compute.instances.getSerialPortOutput '
                'for this VM, and confirm it is running.')
        raise RuntimeError('Unable to retrieve VM serial output. ' + hint)
    return result.stdout


def get_boot_time(name: str, zone: str) -> datetime:
    raw = gcloud('compute', 'instances', 'describe', name, '--zone=' + zone, '--format=json')
    details = json.loads(raw)
    timestamp = details.get('lastStartTimestamp')
    if not isinstance(timestamp, str):
        raise RuntimeError('VM has no lastStartTimestamp. Provision it before reading boot logs.')
    return datetime.fromisoformat(timestamp.replace('Z', '+00:00')).astimezone(timezone.utc)


def get_serial(name: str, zone: str) -> str:
    # A negative offset requests only the most recent half-MB, not old boots
    # and not the many thousands of kernel/guest-agent diagnostic lines.
    content = gcloud('compute', 'instances', 'get-serial-port-output', name,
                     '--zone=' + zone, '--port=1', '--start=-524288')
    if content.lstrip().startswith('{'):
        try:
            parsed = json.loads(content)
            if isinstance(parsed, dict) and isinstance(parsed.get('contents'), str):
                return parsed['contents']
        except ValueError:
            pass
    return content


def events(contents: str, boot_time: datetime) -> list[tuple[str, str]]:
    """Return allowlisted diagnostic events only for the latest VM boot."""
    selected = []
    for raw_line in contents.splitlines():
        m = LOG_TIME.match(raw_line)
        if not m or SCRIPT_MARKER not in raw_line:
            continue
        timestamp = datetime.fromisoformat(m.group(1)).replace(tzinfo=timezone.utc)
        if timestamp < boot_time - timedelta(seconds=5):
            continue
        # Explicitly match only known safe diagnostics; no raw line passthrough.
        stage = SAFE_STAGE.search(raw_line)
        failed = STARTUP_FAILED.search(raw_line)
        http = CURL_HTTP.search(raw_line)
        ready = READY.search(raw_line)
        apt = APT_WARNING.search(raw_line)
        if stage:
            message = stage.group(0)
            selected.append(('fail' if 'FAILED' in message else 'info', message))
        elif failed:
            selected.append(('fail', 'Startup script exited with status ' + failed.group(1)))
        elif http:
            selected.append(('fail', 'curl returned HTTP ' + http.group(1)))
        elif ready:
            selected.append(('ready', ready.group(0)))
        elif apt:
            selected.append(('fail', 'APT repository verification or package lookup failed'))
    return selected


def watch(name: str, zone: str, *, timeout_seconds: int = 720,
          poll_seconds: int = 6) -> int:
    boot = get_boot_time(name, zone)
    print('📋 VM startup events will appear here (safe filtered serial port 1).',
          flush=True)
    print('Boot UTC: ' + boot.isoformat(timespec='seconds'), flush=True)
    seen = set()
    deadline = time.monotonic() + timeout_seconds
    next_heartbeat = time.monotonic() + 45
    last_checkpoint = 'boot sequence not yet observed'
    while time.monotonic() < deadline:
        for kind, message in events(get_serial(name, zone), boot):
            if (kind, message) in seen:
                continue
            seen.add((kind, message))
            if kind == 'info':
                last_checkpoint = message
            print(('✅ ' if kind == 'ready' else '❌ ' if kind == 'fail' else '▫️ ') + message,
                  flush=True)
            if kind == 'ready':
                print('🟢 Terminal ready. Connect from a-Shell: ssh rod@' + name, flush=True)
                return 0
            if kind == 'fail':
                print('Startup failed. Secret Manager references, OAuth and image access '
                      'should be checked based on the last stage shown.', flush=True)
                return 1
        if time.monotonic() >= next_heartbeat:
            print('⏳ Still awaiting terminal-ready; last checkpoint: ' + last_checkpoint,
                  flush=True)
            next_heartbeat = time.monotonic() + 45
        time.sleep(poll_seconds)
    print('No terminal-ready marker before diagnostics timeout. The VM may still be '
          'booting. Check current logs or rerun provisioning; the VM auto-stops '
          'at its session deadline.', flush=True)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name', default='photointel-terminal')
    parser.add_argument('--zone', default='us-central1-a')
    parser.add_argument('--timeout-seconds', type=int, default=720)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', args.name):
        parser.error('Invalid instance name')
    if not re.fullmatch(r'us-central1-[a-z]', args.zone):
        parser.error('Invalid terminal zone')
    if not 15 <= args.timeout_seconds <= 900:
        parser.error('Timeout must be 15 to 900 seconds')
    try:
        return watch(args.name, args.zone, timeout_seconds=args.timeout_seconds)
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        # All exception messages here are static / structured, never provider output.
        print('❌ Terminal diagnostic error: ' + (
            str(exc) if isinstance(exc, RuntimeError) else 'Invalid provider response or timeout'
        ), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
