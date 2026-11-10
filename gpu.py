import json
import re
import shutil
import subprocess
from pathlib import Path

REPO = "rodkisten/photointel"
PROJECT = "photointel"
ENVIRONMENT = "production"


def run(*args, input=None):
    result = subprocess.run(args, input=input, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(f"Falha em {args[0]} {args[1]}: {result.stderr.strip()[:400]}")
    return result.stdout.strip()


for program in ("gh", "gcloud"):
    if not shutil.which(program):
        raise SystemExit(f"Instale/autentique {program} no Codespaces antes de continuar")

path = Path(".env")
if not path.exists():
    raise SystemExit("Arquivo .env não encontrado na raiz do PhotoIntel")
values = {}
for line in path.read_text().splitlines():
    if re.match(r"^(?:export\s+)?[A-Z][A-Z0-9_]*\s*=", line):
        key, value = line.removeprefix("export ").split("=", 1)
        values[key.strip()] = value.strip().strip('"\'')

required = (
    "MODAL_ENDPOINT", "MODAL_TOKEN", "MODAL_PROXY_KEY", "MODAL_PROXY_SECRET",
    "JOYTAG_MODEL_REVISION", "SIGLIP_MODEL_REVISION",
)
if any(not values.get(key) for key in required):
    raise SystemExit(".env incompleto: faltam valores do Modal")
if (not values["MODAL_ENDPOINT"].startswith("https://")
    or not values["MODAL_PROXY_KEY"].startswith("wk-")
    or not values["MODAL_PROXY_SECRET"].startswith("ws-")
    or len(values["MODAL_TOKEN"]) < 32
    or any(not re.fullmatch(r"[0-9a-f]{40}", values[k]) for k in required[-2:])):
    raise SystemExit("Valores Modal inválidos no .env")

configuration = run(
    "gh", "variable", "get", "GCP_CONFIG_ENV", "-R", REPO,
    "-e", ENVIRONMENT, "--json", "value", "--jq", ".value",
)
if "PROJECT_ID=photointel" not in configuration:
    raise SystemExit("GCP_CONFIG_ENV não corresponde ao projeto photointel")
existing = dict(
    line.split("=", 1) for line in configuration.splitlines()
    if "=" in line and not line.startswith("#")
)

def gcloud(*args, input=None):
    return run("gcloud", *args, "--project", PROJECT, "--quiet", input=input)

patch = {
    "EXTRA_ENVIRONMENT__MODAL_ENDPOINT": values["MODAL_ENDPOINT"],
    "EXTRA_ENVIRONMENT__JOYTAG_MODEL_REVISION": values["JOYTAG_MODEL_REVISION"],
    "EXTRA_ENVIRONMENT__SIGLIP_MODEL_REVISION": values["SIGLIP_MODEL_REVISION"],
    "EXTRA_ENVIRONMENT__GPU_MAX_ASSETS_PER_RUN": "1",
    "EXTRA_ENVIRONMENT__GPU_MAX_COST_PER_RUN": "1",
    "EXTRA_ENVIRONMENT__GPU_DAILY_BUDGET": "2",
    "EXTRA_ENVIRONMENT__GPU_MONTHLY_BUDGET": "10",
    "EXTRA_ENVIRONMENT__MAX_GPU_CONCURRENCY": "1",
    "EXTRA_ENVIRONMENT__BATCH_SIZE": "1",
    "ENABLE_GPU": "json:false",
}

for key in ("MODAL_TOKEN", "MODAL_PROXY_KEY", "MODAL_PROXY_SECRET"):
    name_key = f"SECRETS__{key}__NAME"
    secret_name = existing.get(name_key, "photointel-" + key.lower().replace("_", "-"))
    exists = subprocess.run(
        ["gcloud", "secrets", "describe", secret_name, "--project", PROJECT, "--format=json"],
        capture_output=True, text=True,
    )
    if exists.returncode:
        if "NOT_FOUND" not in exists.stderr.upper() and "not found" not in exists.stderr.lower():
            raise SystemExit(f"Não foi possível consultar {secret_name}: {exists.stderr.strip()[:200]}")
        gcloud("secrets", "create", secret_name, "--replication-policy=automatic")
    for account in ("photointel-api", "photointel-jobs"):
        gcloud("secrets", "add-iam-policy-binding", secret_name,
               "--member", f"serviceAccount:{account}@{PROJECT}.iam.gserviceaccount.com",
               "--role", "roles/secretmanager.secretAccessor", "--format=none")
    response = gcloud("secrets", "versions", "add", secret_name,
                      "--data-file=-", "--format=json", input=values[key])
    version = json.loads(response)["name"].rsplit("/", 1)[-1]
    if not version.isdigit():
        raise SystemExit(f"Versão inválida para {secret_name}")
    patch[name_key] = secret_name
    patch[f"SECRETS__{key}__VERSION"] = version
    print(f"✅ {key} enviado ao Secret Manager (versão {version})")

backup = Path(".env.gcp-config-backup")
backup.write_text(configuration + "\n")
backup.chmod(0o600)
lines = [line for line in configuration.splitlines()
         if line.split("=", 1)[0] not in patch]
lines += [f"{key}={value}" for key, value in patch.items()]
run("gh", "variable", "set", "GCP_CONFIG_ENV", "-R", REPO,
    "-e", ENVIRONMENT, input="\n".join(lines) + "\n")
print("✅ GCP_CONFIG_ENV atualizado, demais configurações preservadas")
print("🔒 Credenciais não foram exibidas nem salvas no GitHub")
print("⛔ GPU permanece desativada até a liberação final")
