#!/usr/bin/env python3
"""Streaming ANSI syntax highlighting for GitHub Actions CLI output.

Never modifies raw bytes stored by tee; only the displayed stream is colored.
"""
from __future__ import annotations

import re
import sys

RESET = "\x1b[0m"
RULES = [
    (re.compile(r"(?i)\b(?:traceback|exception|error|failed|failure|fatal|assertionerror|typeerror|referenceerror|syntaxerror|modulenotfounderror|npm err!|ERR_[A-Z_]+)\b"), "1;31"),
    (re.compile(r"(?i)\b(?:warning|warn|deprecated|skipped|pending)\b"), "1;33"),
    (re.compile(r"(?i)\b(?:passed|success|succeeded|ok|done)\b"), "1;32"),
    (re.compile(r"(?i)\b(?:at [\w.$<>]+ \([^()]+:\d+:\d+\)|File \"[^\"]+\", line \d+|[\w./-]+\.(?:py|tsx?|jsx?|mjs|cjs):\d+(?::\d+)?)"), "36"),
    (re.compile(r"(?i)\b(?:pytest|ruff|mypy|node|npm|vitest|jest|playwright|python)\b"), "35"),
]
ANSI = re.compile(r"\\x1b\[[0-9;]*m")
# Avoid rewriting terminal control sequences already emitted by tools.
def highlight(line: str) -> str:
    if "\x1b[" in line:
        return line
    matches = []
    for pattern, color in RULES:
        for match in pattern.finditer(line):
            matches.append((match.start(), match.end(), color))
    matches.sort(key=lambda m: (m[0], -(m[1] - m[0])))
    result, cursor = [], 0
    for start, end, color in matches:
        if start < cursor:
            continue
        result.extend((line[cursor:start], f"\x1b[{color}m", line[start:end], RESET))
        cursor = end
    result.append(line[cursor:])
    return "".join(result)

def main() -> None:
    for line in sys.stdin:
        sys.stdout.write(highlight(line))
        sys.stdout.flush()

if __name__ == "__main__":
    main()
