"""Compact main-only release UI: select source, reuse images, dispatch and wait."""
from contextlib import contextmanager
import itertools
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

from infra.gcp.cloud_cli import run as cloud_run, classify
from infra.terraform.dispatch_media import gh, main as terraform_dispatch

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

SHA = re.compile(r"^[a-f0-9]{40}$")
ROOT = Path(__file__).resolve().parents[2]


def image_catalog(kind: str) -> dict[str, str]:
    image = f"us-central1-docker.pkg.dev/photointel/photointel/{kind}"
    result = cloud_run(["artifacts", "docker", "images", "list", image, "--include-tags", "--format=json"], project="photointel")
    if result.returncode:
        raise RuntimeError("Image inventory failed: " + classify(result.stderr).code)
    sources = {}
    for item in json.loads(result.stdout):
        for tag in item.get("tags", []):
            if SHA.fullmatch(tag):
                sources[tag] = max(sources.get(tag, ""), item.get("uploadTime", item.get("updateTime", "")))
    return sources


def newest_common(catalogs: list[dict[str, str]]) -> str:
    common = set(catalogs[0]).intersection(*(set(c) for c in catalogs[1:]))
    if not common:
        raise RuntimeError("No complete published release. Choose main + build.")
    return max(common, key=lambda sha: (min(c[sha] for c in catalogs), sha))


def validate_source(sha: str, head: str) -> str:
    if not SHA.fullmatch(sha):
        raise ValueError("Use a full SHA")
    subprocess.run(["git", "cat-file", "-e", sha + "^{commit}"], cwd=ROOT, check=True)
    subprocess.run(["git", "merge-base", "--is-ancestor", sha, head], cwd=ROOT, check=True)
    return sha


def last_frontend(app: str) -> str:
    from infra.scripts.prepare_workflow_env import read_config
    from infra.scripts.cloudflare_setup import client
    api = client(read_config())
    worker = "photointel" if app == "web" else "photointel-manage"
    settings = api.get(api.base + f"/workers/scripts/{worker}/settings")
    key = "RELEASE_SHA" if app == "web" else "BUILD_SOURCE_SHA"
    saved = [binding.get("text", "") for binding in settings.get("bindings", []) if binding.get("name") == key and binding.get("type") == "plain_text"]
    if len(saved) == 1 and SHA.fullmatch(saved[0]):
        return saved[0]
    # Bootstrap compatibility: old publications predate historical-source input.
    runs = gh("api", "repos/rodkisten/photointel/actions/workflows/deploy-worker.yml/runs?branch=main&status=success&per_page=100")
    expected = "🌐 Publish Photos Worker" if app == "web" else "🧰 Publish Manage Worker"
    for run in runs["workflow_runs"]:
        jobs = gh("api", f"repos/rodkisten/photointel/actions/runs/{run['id']}/jobs?per_page=100")
        if any(job["name"] == expected and job["conclusion"] == "success" for job in jobs["jobs"]):
            return run["head_sha"]
    raise RuntimeError("No published frontend release found. Choose main.")


def frontend_dispatch(app: str, sha: str, action: str) -> None:
    request = f"release-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}-{app}"
    title = f"🌐 {action} · {app} · {request}"
    endpoint = "repos/rodkisten/photointel/actions/workflows/deploy-worker.yml"
    
    with auto_step(f"Disparando Deploy Frontend ({app})"):
        gh("api", "--method", "POST", endpoint + "/dispatches", "--input", "-", payload={
            "ref": "main", "inputs": {"action": action, "app": app, "sha": sha, "request_id": request},
        })
        run = None
        deadline = time.monotonic() + 3600
        while time.monotonic() < deadline:
            if run is None:
                matches = [r for r in gh("api", endpoint + "/runs?branch=main&event=workflow_dispatch&per_page=100")["workflow_runs"] if r["display_title"] == title]
                if len(matches) > 1:
                    raise RuntimeError("Ambiguous frontend dispatch")
                if matches:
                    run = matches[0]
                    logger.info(f"🔗 URL: {run['html_url']}")
            else:
                run = gh("api", f"repos/rodkisten/photointel/actions/runs/{run['id']}")
                if run["status"] == "completed":
                    if run["conclusion"] != "success":
                        raise RuntimeError("Frontend failed: " + run["html_url"])
                    return
            time.sleep(15)
        raise RuntimeError("Frontend timed out; inspect the linked run before retrying")


def build_images(target: str, sha: str) -> None:
    with auto_step(f"Build e Teste de Imagens ({target})"):
        with tempfile.TemporaryDirectory(prefix="photointel-source-") as temp:
            source = Path(temp) / "source"
            subprocess.run(["git", "worktree", "add", "--detach", str(source), sha], cwd=ROOT, check=True)
            try:
                config = json.loads((ROOT / "infra/gcp/config.local.json").read_text())
                config["release_git_sha"] = sha
                config["image"] = "us-central1-docker.pkg.dev/photointel/photointel/api:" + sha
                path = source / "infra/gcp/config.local.json"
                path.write_text(json.dumps(config))
                path.chmod(0o600)
                env = {**os.environ, "PHOTOINTEL_REPO_ROOT": str(source)}
                if target == "media":
                    for kind in ("image", "video"):
                        folder = source / "services/media" / kind
                        subprocess.run(["npm", "ci" if (folder / "package-lock.json").exists() else "install", "--no-audit", "--no-fund"], cwd=folder, check=True)
                        subprocess.run(["npm", "run", "build"], cwd=folder, check=True)
                        subprocess.run(["npm", "test"], cwd=folder, check=True)
                command = "build" if target == "api" else "media-build"
                subprocess.run(["python3", "-m", "infra.gcp.manage", command, "--git-sha", sha,
                                "--apply", "--authorize-charges", "--confirm-project", "photointel"],
                               cwd=ROOT, env=env, check=True)
            finally:
                subprocess.run(["git", "worktree", "remove", "--force", str(source)], cwd=ROOT, check=True)


def database_gate() -> None:
    with auto_step("Verificando Database Gate (Neon)"):
        subprocess.run(["bash", "infra/gcp/release.sh", "gate"], cwd=ROOT,
                       env={**os.environ, "CONFIRM_PROJECT": "photointel"}, check=True)


def main() -> None:
    action, target = os.environ["ACTION"], os.environ["TARGET"]
    origin, requested = os.environ["SOURCE"], os.environ.get("REQUESTED_SHA", "").strip()
    
    if action not in {"plan", "build", "deploy", "build-and-deploy"} or target not in {"api", "media", "web", "manage"} or origin not in {"main", "last"}:
        raise ValueError("Invalid release selection")
    if os.environ["GITHUB_REF"] != "refs/heads/main":
        raise ValueError("Run from main")
    if action != "plan" and os.environ.get("CONFIRM") != "true":
        raise ValueError("Confirm the operation")
        
    if target == "api" and action in {"deploy", "build-and-deploy"}:
        database_gate()
        
    catalogs = []
    if target in {"api", "media"}:
        with auto_step("Lendo Catálogo de Imagens"):
            catalogs = [image_catalog(name) for name in (["api"] if target == "api" else ["media-image", "media-video"])]
            
    head = os.environ["GITHUB_SHA"]
    selected = requested or (head if origin == "main" else newest_common(catalogs) if catalogs else last_frontend(target))
    validate_source(selected, head)
    
    logger.info(f"\n🚀 Resumo da Execução:\n• Ação: {action}\n• Alvo: {target}\n• Origem: {origin}\n• SHA: {selected[:10]}..\n")
    
    if target in {"web", "manage"} and action != "plan":
        frontend_dispatch(target, selected, "build" if action == "build" else "build-and-deploy")
        return
        
    if catalogs and action != "plan" and not all(selected in c for c in catalogs):
        build_images(target, selected)
        if not all(selected in image_catalog(name) for name in (["api"] if target == "api" else ["media-image", "media-video"])):
            raise RuntimeError("Build finished without the requested images; deploy blocked")
    elif catalogs and action != "plan":
        logger.info("\n✔ Imagens publicadas reutilizadas; sem rebuild necessário.\n")
        
    if action == "build":
        return
        
    os.environ["TF_ACTION"] = "plan" if action == "plan" else "apply"
    os.environ["TF_SCOPE"] = "cloudflare" if target in {"web", "manage"} else "gcp"
    
    image_sha = "" if action == "plan" and not requested and origin == "main" else selected
    os.environ["IMAGE_SHA"] = image_sha if target == "media" else ""
    os.environ["API_SHA"] = image_sha if target == "api" else ""
    
    with auto_step(f"Executando Terraform ({os.environ['TF_ACTION']})"):
        terraform_dispatch()


if __name__ == "__main__":
    main()
