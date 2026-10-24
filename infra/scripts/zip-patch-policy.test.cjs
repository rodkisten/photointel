"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { sensitivePathReason, assertSafePatchPaths } = require("./zip-patch-policy.cjs");

test("source patches and explicitly safe environment examples remain supported", () => {
  assert.doesNotThrow(() => assertSafePatchPaths([
    ".env.example", ".env.runtime.example", "docs/.env.example",
    "apps/api/src/photointel/config.py", "cloudbuild.yaml", "infra/gcp/config.example.json",
    "tests/fixtures/data/metadata.json", "docs/operations/backups.md", "apps/web/dist/index.html",
  ]));
});

test("credentials and private runtime artifacts cannot be force-added", () => {
  for (const filename of [
    ".env", ".env.production", "docs/.env.runtime", ".ENV", ".env.example.bak",
    "var/session/cookies", "backups/catalog.dump", "data/private.jpg", "exports/assets.csv",
    "keys/r2.key", "key.PEM", "keys/apple.p12", "key.p8", "key.pfx", "device.keystore",
    "gha-creds-123.json", "nested/gha-creds-123.json", "credentials.json",
    "secrets/token.txt", "config/service-account-prod.json", "service_account.json",
    "application_default_credentials.json", ".aws/config", ".ssh/id_ed25519",
    "keys/id_rsa", ".netrc", ".npmrc", ".docker/config.json", ".config/gcloud/configurations/a",
    "infra/gcp/config.local.json", "infra/gcp/rendered/api.yaml", "infra/gcp/state/release.json",
    "nested/state.tfstate.backup", "..\\secret", "/tmp/secret", "C:\\secret",
  ]) {
    assert.ok(sensitivePathReason(filename), `${filename} must be rejected`);
    assert.throws(() => assertSafePatchPaths([filename]), /ZIP patch rejected/);
  }
});

test("actual workflow rejects a wrapped private batch before copying any file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "photointel-zip-policy-"));
  try {
    const repo = path.join(directory, "repo");
    const patchRoot = path.join(directory, "extracted", "photointel");
    fs.mkdirSync(path.join(repo, "infra/scripts"), { recursive: true });
    fs.copyFileSync(__dirname + "/zip-patch-policy.cjs", repo + "/infra/scripts/zip-patch-policy.cjs");
    fs.writeFileSync(path.join(repo, "README.md"), "original source");
    fs.mkdirSync(path.join(patchRoot, "var/icloud-session"), { recursive: true });
    fs.writeFileSync(path.join(patchRoot, "README.md"), "patch source");
    fs.writeFileSync(path.join(patchRoot, "var/icloud-session/cookies"), "synthetic token");
    const workflow = fs.readFileSync(
      path.join(__dirname, "../../.github/workflows/zip.yml"), "utf8",
    );
    const applyStep = workflow.split(/\n        id: apply\n/)[1];
    assert.ok(applyStep, "workflow must define the stable apply step ID");
    const script = applyStep.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)[1]
      .split("\n").map((line) => line.slice(10)).join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, GITHUB_WORKSPACE: repo, PATCH_ROOT: patchRoot },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ZIP patch rejected \(private runtime/);
    assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "original source");
    assert.equal(fs.existsSync(path.join(repo, "var")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reject invalid paths without interpreting them as executable code", () => {
  for (const filename of ["", null, "foo\nbar", "foo\u007fbar", "../.env", ".git/config"]) {
    assert.ok(sensitivePathReason(filename));
  }
  assert.equal(sensitivePathReason("docs/$(echo harmless).md"), null);
});
