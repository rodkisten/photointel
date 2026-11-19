#!/usr/bin/env python3
"""Render sanitized, narrow-screen friendly GitHub Actions failure excerpts."""
import re
import sys
from pathlib import Path

ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
HIGHLIGHT = re.compile(r"error|failed|fatal|traceback|exception|permission.denied|not found|cannot find|TS\\d{4,5}|✖|✗", re.I)
SECRET = re.compile(r"(?i)(bearer\s+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*)\S+")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
def render(path: str) -> None:
    raw = Path(path).read_bytes().decode("utf-8", errors="replace")
    lines = []
    for line in raw.splitlines():
        line = ANSI.sub("", line)
        line = CONTROL.sub("", line).strip()
        if HIGHLIGHT.search(line):
            line = SECRET.sub(lambda m: m.group(1) + "[redacted]", line)
            line = line.replace("`", "'").replace("|", "¦")
            if len(line) > 180:
                line = line[:177] + "…"
            if line and line not in lines:
                lines.append(line)
    if not lines:
        print("> Nenhuma linha de erro reconhecida. Consulte os logs completos.")
        return
    for line in lines[-12:]:
        print("> " + line.replace("<", "&lt;").replace(">", "&gt;"))
if __name__ == "__main__":
    render(sys.argv[1])
