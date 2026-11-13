"""Dispatch the existing TF workflow using the runner's scoped GitHub token.

The TF workflow keeps its existing WIF trust boundary. No bootstrap credential,
service account key, or expanded WIF workflow allowlist is needed by Media.
"""
from contextlib import contextmanager
import itertools
import logging
import os
import re
import time

from .gh_client import gh  # Importa a função gh separada

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

_step_counter = itertools.count(1)

@contextmanager
def auto_step(name: str):
    step_num = next(_step_counter)
    logger.info(f"\n▶ [Step {step_num}] {name}...\n")
    start = time.perf_counter()
    try:
        yield
        elapsed = time.perf_counter() - start
        logger.info(f"\n✔ [Step {step_num}] Finalizado em {elapsed:.2f}s\n")
    except Exception as e:
        logger.error(f"\n✖ [Step {step_num}] Erro: {e}\n")
        raise


def main():
    repo = os.environ["GITHUB_REPOSITORY"]
    if repo != "rodkisten/photointel":
        raise ValueError("Unexpected repository")
        
    sha = os.environ.get("IMAGE_SHA", "")
    if sha and not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Full media source SHA required")
        
    action = os.environ.get("TF_ACTION") or ("plan" if os.environ.get("MEDIA_ACTION") == "plan" else "apply")
    scope = os.environ.get("TF_SCOPE", "gcp")
    
    if action not in {"plan", "apply"} or scope not in {"gcp", "cloudflare"}:
        raise ValueError("Invalid Terraform dispatch scope/action")
        
    correlation = f"media-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    title = f"TF · {action} · {scope} · {correlation}"
    endpoint = f"repos/{repo}/actions/workflows/tf-production.yml"
    
    logger.info(f"\n🚀 Configuração Terraform:\n• Ação: {action}\n• Escopo: {scope}\n• Correlação: {correlation}\n")
    
    with auto_step("Disparando workflow do Terraform via API"):
        payload_data = {
            "ref": "main", 
            "inputs": {
                "action": action, 
                "authorize_apply": str(action == "apply").lower(),
                "runtime_targets": os.environ.get("TF_TARGETS", "api,jobs"), 
                "image_sha": sha, 
                "api_sha": os.environ.get("API_SHA", ""), 
                "scope": scope, 
                "request_id": correlation, 
                "expected_sha": os.environ["GITHUB_SHA"]
            }
        }
        gh("api", "--method", "POST", endpoint + "/dispatches", "--input", "-", payload=payload_data)

    with auto_step("Aguardando conclusão do Terraform"):
        deadline = time.monotonic() + 3000
        run = None
        while time.monotonic() < deadline:
            if run is None:
                runs = gh("api", endpoint + "/runs?branch=main&event=workflow_dispatch&per_page=100")
                matches = [r for r in runs["workflow_runs"] if r["display_title"] == title]
                if len(matches) > 1:
                    raise RuntimeError("Ambiguous Terraform dispatch; inspect Actions")
                if matches:
                    run = matches[0]
                    logger.info(f"🔗 Terraform run URL:\n{run['html_url']}")
                    summary = os.environ.get("GITHUB_STEP_SUMMARY")
                    if summary:
                        with open(summary, "a") as handle:
                            handle.write(f"\nTerraform {action}: {run['html_url']}\nMedia source: `{sha}`\n")
            else:
                run = gh("api", f"repos/{repo}/actions/runs/{run['id']}")
                if run["status"] == "completed":
                    if run["conclusion"] != "success":
                        raise RuntimeError(f"Terraform {action} failed: {run['html_url']}")
                    logger.info(f"✔ Terraform {action} e verificação bem-sucedidos:\n{run['html_url']}")
                    return
            time.sleep(15)
        raise RuntimeError("Timed out waiting for Terraform; inspect the linked run before retrying")


if __name__ == "__main__":
    main()
