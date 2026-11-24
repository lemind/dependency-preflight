#!/usr/bin/env bash
# Saves a pinned copy of a public repository's npm dependency files as a test fixture.
# Usage: scripts/fetch-fixture.sh <name> <owner/repo> <commit-sha> <path-regex>
#   <path-regex> selects which files (lockfiles, manifests, workspace config) to save, e.g. '^sdk/(package\.json|yarn\.lock)$'.
# Writes test/fixtures/real/<name>/files/<original path> and test/fixtures/real/<name>/fixture.json with the commit,
# retrieval date, the sha256 of every saved file, and every dependency file present at that commit (saved or not).
# The saved files are untrusted data: they are read, never executed.
set -euo pipefail

name=$1 repo=$2 sha=$3 pattern=$4
root="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures/real/$name"
rm -rf "$root"
mkdir -p "$root/files"

tree=$(gh api "repos/$repo/git/trees/$sha?recursive=1")
if [ "$(jq -r .truncated <<<"$tree")" != "false" ]; then
  echo "Tree listing for $repo@$sha is truncated" >&2
  exit 1
fi

dependency_files='(^|/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|pnpm-workspace\.yaml)$'
mapfile -t paths < <(jq -r --arg p "$pattern" '.tree[] | select(.type == "blob") | .path | select(test($p))' <<<"$tree")
if [ "${#paths[@]}" -eq 0 ]; then
  echo "No files match $pattern" >&2
  exit 1
fi

saved='[]'
for path in "${paths[@]}"; do
  mkdir -p "$root/files/$(dirname "$path")"
  gh api "repos/$repo/contents/$path?ref=$sha" -H "Accept: application/vnd.github.raw" >"$root/files/$path"
  hash=$(sha256sum "$root/files/$path" | cut -d' ' -f1)
  saved=$(jq --arg path "$path" --arg sha256 "$hash" '. + [{path: $path, sha256: $sha256}]' <<<"$saved")
done

jq -n \
  --arg repository "$repo" \
  --arg commit "$sha" \
  --arg retrieved "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg selection "$pattern" \
  --argjson files "$saved" \
  --argjson dependencyFilesAtCommit "$(jq --arg p "$dependency_files" '[.tree[] | select(.type == "blob") | .path | select(test($p))]' <<<"$tree")" \
  '{repository: $repository, commit: $commit, retrieved: $retrieved, selection: $selection, files: $files, dependencyFilesAtCommit: $dependencyFilesAtCommit}' \
  >"$root/fixture.json"

echo "Saved ${#paths[@]} files to $root"
