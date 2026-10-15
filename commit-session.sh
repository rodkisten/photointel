#!/usr/bin/env bash
# Commit and push repository changes from an interactive GitHub Actions SSH session.
set -Eeuo pipefail

cd "${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}"

if [[ "${GITHUB_REF_TYPE:-branch}" != 'branch' ]]; then
  echo '::error::Auto-push is supported for branches only.'
  exit 1
fi

branch="${GITHUB_REF_NAME:-}"
if [[ -z "$branch" ]]; then
  echo '::error::Missing GITHUB_REF_NAME.'
  exit 1
fi

# Push only to the original branch, even if the SSH user switched branches.
current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ "$current_branch" != "$branch" ]]; then
  echo "::error::Current branch is '$current_branch', expected '$branch'."
  exit 1
fi

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

# Track modifications, new files, and deletions. Do not stage common secrets.
# .gitignore rules still apply. The exclusions below also cover tracked files.
git add -A -- . \
  ':(exclude).env' ':(exclude)**/.env' \
  ':(exclude).env.*' ':(exclude)**/.env.*' \
  ':(exclude).npmrc' ':(exclude)**/.npmrc' \
  ':(exclude).pypirc' ':(exclude)**/.pypirc' \
  ':(exclude)*.pem' ':(exclude)**/*.pem' \
  ':(exclude)*.key' ':(exclude)**/*.key' \
  ':(exclude)id_rsa' ':(exclude)**/id_rsa' \
  ':(exclude)id_ed25519' ':(exclude)**/id_ed25519' \
  ':(glob,exclude)**/node_modules/**' \
  ':(glob,exclude)**/.venv/**' \
  ':(glob,exclude)**/venv/**' \
  ':(glob,exclude)**/__pycache__/**' \
  ':(glob,exclude)**/.pytest_cache/**'

echo '=== Staged changes ==='
git diff --cached --stat

if ! git diff --cached --quiet; then
  git commit -m "chore: save SSH development session (run ${GITHUB_RUN_NUMBER:-manual})"
else
  echo 'No new modifications to commit.'
fi

# Also publish commits the user may have created manually during SSH.
git fetch --no-tags origin "refs/heads/$branch"

if git merge-base --is-ancestor HEAD FETCH_HEAD; then
  echo 'Branch already published. No push needed.'
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo 'No unpublished session changes.' >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

# Integrate possible changes pushed by someone else while SSH was active.
# Never force-push. If there is a conflict, fail visibly instead.
if ! git -c rebase.autoStash=true rebase FETCH_HEAD; then
  echo '::error::Automatic rebase failed; branch was not pushed.'
  exit 1
fi

git push origin "HEAD:refs/heads/$branch"
sha="$(git rev-parse HEAD)"
echo "Successfully pushed $sha to $branch"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo '### Auto Commit + Push completed'
    echo "- Branch: \`$branch\`"
    echo "- Commit: [\`$sha\`](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/commit/$sha)"
  } >> "$GITHUB_STEP_SUMMARY"
fi
