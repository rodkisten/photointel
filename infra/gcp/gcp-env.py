import json
import os
import pathlib
import re
from io import StringIO
from dotenv import dotenv_values

raw = os.environ.get('GCP_CONFIG_ENV', '')
if not raw.strip():
  raise SystemExit('Missing production environment secret: GCP_CONFIG_ENV')

env_values = dotenv_values(stream=StringIO(raw), interpolate=False)
config = {}

print(env_values)

for name, raw_value in env_values.items():
  if raw_value is None:
      raise SystemExit(f'Environment key without value: {name}')
  segments = name.split('__')
  if not all(re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', s) for s in segments):
      raise SystemExit(f'Invalid environment key: {name}')

  root = segments[0].lower()
  if root == 'secrets' and len(segments) >= 2:
      # Preserve exact Secret Manager environment variable names.
      # SECRETS__DATABASE_URL__NAME -> secrets.DATABASE_URL.name
      if len(segments) != 3 or not re.fullmatch(r'[A-Z][A-Z0-9_]*', segments[1]):
          raise SystemExit(f'Expected SECRETS__UPPERCASE_KEY__NAME/VERSION: {name}')
      if segments[2].upper() not in ('NAME', 'VERSION'):
          raise SystemExit(f'Invalid secret reference property: {name}')
      path_parts = ['secrets', segments[1], segments[2].lower()]
  elif root == 'extra_environment' and len(segments) == 2:
      # EXTRA_ENVIRONMENT__FOO -> extra_environment.FOO
      path_parts = ['extra_environment', segments[1]]
  else:
      path_parts = [segment.lower() for segment in segments]

  if raw_value.startswith('json:'):
      try:
          value = json.loads(raw_value[5:])
      except json.JSONDecodeError as exc:
          raise SystemExit(f'Invalid JSON value for {name}: {exc}') from exc
  else:
      value = raw_value

  target = config
  for part in path_parts[:-1]:
      if part not in target:
          target[part] = {}
      if not isinstance(target[part], dict):
          raise SystemExit(f'Conflicting nested configuration key: {name}')
      target = target[part]
  leaf = path_parts[-1]
  if leaf in target:
      raise SystemExit(f'Duplicate configuration key: {name}')
  target[leaf] = value

for field in ('project_id', 'region', 'repository'):
  if not isinstance(config.get(field), str) or not config[field].strip():
      raise SystemExit(f'Missing or invalid configuration field: {field}')
if config['project_id'] != os.environ['CONFIRM_PROJECT']:
  raise SystemExit('Project confirmation mismatch')

sha = os.environ['RELEASE_SHA']
if not re.fullmatch(r'[a-f0-9]{40}', sha):
  raise SystemExit('Invalid release SHA')

# Deterministic image built from this exact checked-out commit.
config['release_git_sha'] = sha
config['image'] = (
  f"{config['region']}-docker.pkg.dev/{config['project_id']}/"
  f"{config['repository']}/api:{sha}"
)

path = pathlib.Path('infra/gcp/config.local.json')
path.parent.mkdir(parents=True, exist_ok=True)
os.umask(0o077)

final = json.dumps(config, ensure_ascii=False, indent=2) 
path.write_text(final + '\n', encoding='utf-8')
path.chmod(0o600)

print("FINAL ENV!")
print(final)
