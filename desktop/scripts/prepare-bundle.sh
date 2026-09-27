#!/usr/bin/env bash
# Bash equivalent of prepare-bundle.ps1 (for Linux/macOS/Git Bash, e.g. CI).
# Stages desktop/bundle/ with the pinned win-x64 node.exe and the web app plus
# production node_modules. The Windows node.exe cannot run here, so npm ci uses
# the system npm; the dependencies are pure JavaScript, so the output is the same.
set -euo pipefail

desktop_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(dirname "$desktop_dir")"
pin="$desktop_dir/node-pin.json"
json() { node -e 'const p=require(process.argv[1]); process.stdout.write(String(p[process.argv[2]]))' "$pin" "$1"; }
version="$(json version)"; file="$(json file)"; pinned="$(json sha256)"
cache="$desktop_dir/.cache"; bundle="$desktop_dir/bundle"; zip="$cache/$file"
base="https://nodejs.org/dist/v$version"
sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$1" | cut -d' ' -f1; }

mkdir -p "$cache"
echo "Node v$version: checking SHASUMS256.txt"
official="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$file" '$2==f {print $1}')"
[ -n "$official" ] || { echo "$file not listed in $base/SHASUMS256.txt" >&2; exit 1; }
[ "$official" = "$pinned" ] || { echo "Pinned sha256 $pinned != SHASUMS256.txt $official" >&2; exit 1; }

if [ ! -f "$zip" ] || [ "$(sha "$zip")" != "$official" ]; then
  echo "Downloading $base/$file"
  curl -fsSL "$base/$file" -o "$zip.download"
  actual="$(sha "$zip.download")"
  [ "$actual" = "$official" ] || { rm -f "$zip.download"; echo "SHA256 mismatch: expected $official, got $actual" >&2; exit 1; }
  mv -f "$zip.download" "$zip"
fi
echo "Verified $file sha256 $official"

rm -rf "$bundle"; mkdir -p "$bundle/node" "$bundle/app"
dist="${file%.zip}"
unzip -q -j -o "$zip" "$dist/node.exe" "$dist/LICENSE" -d "$bundle/node"

cp "$repo_root"/{server.js,package.json,package-lock.json} "$bundle/app/"
cp -R "$repo_root/lib" "$repo_root/public" "$bundle/app/"
echo "npm ci --omit=dev (system npm $(npm -v))"
(cd "$bundle/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
# Drop dot-entries (.bin shims, .package-lock.json, .github, lint configs):
# unused at runtime and awkward for ClickOnce manifests.
find "$bundle/app/node_modules" -depth -name '.*' -exec rm -rf {} +

commit="$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || true)"
dirty=false
[ -n "$(git -C "$repo_root" status --porcelain -- server.js lib public package.json package-lock.json 2>/dev/null)" ] && dirty=true
cat > "$bundle/bundle-info.json" <<JSON
{
  "nodeVersion": "$version",
  "nodeSha256": "$official",
  "appCommit": "$commit",
  "appDirty": $dirty,
  "preparedAt": "$(date -Iseconds)"
}
JSON
echo "Bundle ready: $bundle ($(find "$bundle" -type f | wc -l) files)"
