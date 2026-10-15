#!/usr/bin/env python3
"""Container liveness from a heartbeat written by the process event loop."""
import argparse
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--role", choices=("worker", "ingestion"), required=True)
parser.add_argument("--maximum-age", type=int, default=120)
args = parser.parse_args()
path = Path(f"/tmp/photointel-{args.role}.heartbeat")
if args.maximum_age < 5 or not path.is_file() or path.is_symlink():
    raise SystemExit(1)
try:
    stamp = float(path.read_text().strip())
except (OSError, ValueError):
    raise SystemExit(1) from None
age = time.time() - stamp
raise SystemExit(0 if 0 <= age <= args.maximum_age else 1)
