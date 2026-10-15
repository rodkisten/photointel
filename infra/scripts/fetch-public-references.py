#!/usr/bin/env python3
"""Fetch public references only; never install packages or download model weights."""

import argparse
import concurrent.futures
import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
bootstrap_path = Path(__file__).with_name("network-bootstrap.py")
specification = importlib.util.spec_from_file_location(
    "public_references", bootstrap_path
)
if specification is None or specification.loader is None:
    raise SystemExit("Cannot load public reference helpers")
module = importlib.util.module_from_spec(specification)
specification.loader.exec_module(module)
module.RESEARCH = args.output
tasks = {
    "joytag": lambda: module.model_stage("fancyfeast/joytag", "joytag"),
    "siglip2": lambda: module.model_stage("google/siglip2-base-patch16-224", "siglip2"),
    "references": module.reference_stage,
}
results = {}
with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as executor:
    futures = {executor.submit(function): name for name, function in tasks.items()}
    for future in concurrent.futures.as_completed(futures):
        name = futures[future]
        try:
            results[name] = future.result()
        except Exception as error:
            results[name] = [{"status": "failed", "error_type": type(error).__name__}]
(args.output / "reference-status.json").write_text(json.dumps({
    "executed_at": datetime.now(UTC).isoformat(), "sources": results,
    "model_weights_downloaded": False,
}, indent=2) + "\n")
for name, entries in results.items():
    successes = sum(entry.get("status") == "passed" for entry in entries)
    print(f"{name}: {successes}/{len(entries)} references fetched")
