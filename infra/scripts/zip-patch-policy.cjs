"use strict";

// ZIP patches are source changes. Never force-add local credentials or runtime data.
const path = require("node:path");

const SAFE_ENV_EXAMPLES = new Set([".env.example", ".env.runtime.example"]);
const PRIVATE_DIRECTORIES = new Set([
  ".aws", ".ssh", ".gnupg", ".kube", ".terraform", ".secrets", "secrets",
]);
const PRIVATE_ROOTS = new Set(["var", "backups", "data", "exports"]);

function sensitivePathReason(filename) {
  if (typeof filename !== "string" || !filename || /[\x00-\x1f\x7f]/.test(filename)) {
    return "invalid path";
  }
  const normalized = filename.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (path.posix.isAbsolute(normalized) || /^[a-z]:\//i.test(normalized) ||
      parts.includes("..") || !parts.length) {
    return "path escapes the repository";
  }
  const lower = parts.map((part) => part.toLowerCase());
  const name = lower.at(-1);
  if (lower.includes(".git")) return "Git metadata";
  if (lower.some((part) => PRIVATE_DIRECTORIES.has(part))) {
    return "credential directory";
  }
  if (PRIVATE_ROOTS.has(lower[0])) return "private runtime or backup directory";
  if (lower.some((part) => /^\.env(?:\.|$)/.test(part) &&
      !SAFE_ENV_EXAMPLES.has(part))) {
    return "environment credentials";
  }
  if (/\.(?:pem|key|p12|pfx|p8|jks|keystore)$/i.test(name) ||
      /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(name)) {
    return "private key or certificate bundle";
  }
  if (/^gha-creds-.*\.json$/.test(name) ||
      /^(?:application_default_credentials|credentials?|service[-_]account[^/]*)\.json$/.test(name) ||
      ["credentials", "config.json", ".netrc", ".pypirc", ".npmrc"].includes(name) &&
      (name !== "config.json" || lower.includes(".docker"))) {
    return "credential file";
  }
  if (/^config\.local(?:\.|$)/.test(name) ||
      /\.tfstate(?:\.|$)/.test(name) ||
      lower.some((part, index) => part === "gcloud" && lower[index - 1] === ".config")) {
    return "local account configuration or infrastructure state";
  }
  for (let index = 0; index < lower.length - 2; index += 1) {
    if (lower[index] === "infra" && lower[index + 1] === "gcp" &&
        ["rendered", "state"].includes(lower[index + 2])) {
      return "local deployment state";
    }
  }
  return null;
}

function assertSafePatchPaths(filenames) {
  for (const filename of filenames) {
    const reason = sensitivePathReason(filename);
    if (reason) throw new Error(`ZIP patch rejected (${reason}): ${filename}`);
  }
}

module.exports = { sensitivePathReason, assertSafePatchPaths };
