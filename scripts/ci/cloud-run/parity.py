"""Offline migration parity check; no cloud credentials or provider calls."""
import json
import subprocess
import tempfile
from pathlib import Path
from infra.gcp.manage import render, validate

fixture = json.loads(Path("scripts/ci/cloud-run/fixture.json").read_text())
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    config = root / "config.json"
    config.write_text(json.dumps(fixture))
    render(validate(fixture), root / "legacy")
    subprocess.run(["node", "scripts/ci/cloud-run/render.ts", str(config), str(root / "native")], check=True)
    subprocess.run(["node", "scripts/ci/cloud-run/compare.ts", str(root / "legacy"), str(root / "native")], check=True)
