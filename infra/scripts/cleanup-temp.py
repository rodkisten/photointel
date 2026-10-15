#!/usr/bin/env python3
"""Remove expired temporary derivatives only, never an iCloud/library directory."""
import argparse
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--directory", type=Path, default=Path("var/processing"))
parser.add_argument("--hours", type=int, default=24)
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
allowed = root / "var" / "processing"
directory = args.directory.resolve()
if (
    directory != allowed
    or (root / "var").is_symlink()
    or allowed.is_symlink()
    or args.hours < 1
):
    parser.error(
        "Somente var/processing deste repositório e retenção >=1h são permitidos"
    )
cutoff = time.time() - args.hours * 3600
removed = 0
if directory.exists():
    for path in directory.rglob("*"):
        if path.is_symlink() or not path.is_file() or path.stat().st_mtime >= cutoff:
            continue
        if args.apply:
            path.unlink()
        removed += 1
print(f"{'Removidos' if args.apply else 'Candidatos'}: {removed} arquivos temporários")
