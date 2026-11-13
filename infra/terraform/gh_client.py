"""Utilitário centralizado para requisições à API do GitHub."""
import json
import logging
import subprocess

logger = logging.getLogger(__name__)

def gh(*args: str, payload=None):
    cmd_str = f"gh {' '.join(args)}"
    if payload:
        cmd_str += f" --input - (payload keys: {list(payload.keys())})"
    logger.info(f"💻 Rodando: {cmd_str}")
    
    result = subprocess.run(["gh", *args], input=json.dumps(payload) if payload else None,
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"GitHub Actions request failed: {result.stderr.strip() or 'check Actions write permission'}")
    return json.loads(result.stdout) if result.stdout.strip() else None
