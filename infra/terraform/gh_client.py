"""GitHub API CLI helper with safe diagnostics and transient GET retries."""
import json
import logging
import os
import re
import subprocess
import time

logger = logging.getLogger(__name__)


def gh(*args: str, payload=None):
    """Dispatch POSTs may return HTTP 204; GETs must return JSON."""
    is_read = len(args) >= 2 and args[0] == "api" and "--method" not in args and payload is None
    endpoint = args[-1].split("?")[0]
    logger.info("GitHub API: %s", endpoint)

    # Prepara o ambiente: só sobrescreve GH_TOKEN se BOT_TOKEN existir e não for vazio
    env = {
        **os.environ,
        "GH_FORCE_TTY": "0",
        "NO_COLOR": "1",
        "CLICOLOR": "0",
        "GH_PAGER": "cat",
    }
    bot_token = os.environ.get("BOT_TOKEN", "").strip()
    if bot_token:
        env["GH_TOKEN"] = bot_token

    attempts = 3 if is_read else 1

    for attempt in range(attempts):
        result = subprocess.run(
            ["gh", *args],
            input=json.dumps(payload) if payload is not None else None,
            capture_output=True,
            text=True,
            check=False,
            env=env,
        )
        if result.returncode:
            detail = result.stderr.strip()
            raise RuntimeError(
                f"GitHub API failed (exit {result.returncode}, endpoint {endpoint}): "
                + (detail[:500] if detail else "verify token permissions")
            )
        # gh may inherit a forced TTY from CI log formatting, producing ANSI
        # sequences and formatted output instead of a machine-readable body.
        body = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", result.stdout).strip()
        if not body:
            if not is_read:
                return None
            error = "empty response body"
        else:
            try:
                return json.loads(body)
            except json.JSONDecodeError as exc:
                # Report only the response shape, never its contents or secrets.
                error = (
                    f"invalid JSON ({exc.msg} at character {exc.pos}; "
                    f"length={len(body)}, first_codepoint={ord(body[0]) if body else 0})"
                )
        if attempt + 1 < attempts:
            logger.warning("GitHub API GET: %s; retry %d/%d", error, attempt + 1, attempts - 1)
            time.sleep(2 * (attempt + 1))

    raise RuntimeError(
        f"GitHub API GET returned {error} after {attempts} attempts "
        f"(endpoint {endpoint}); check gh CLI output and API permissions"
    )
