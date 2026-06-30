#!/bin/sh
set -eu

repo_url="https://github.com/frankekn/needlefish.git"
root="$HOME/.local/share/needlefish"
releases="$root/releases"
bin_dir="$HOME/.local/bin"

mkdir -p "$releases" "$bin_dir"
tmp=$(mktemp -d "$releases/.tmp.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

git clone --depth 1 --branch main "$repo_url" "$tmp/repo"
cd "$tmp/repo"

if ! command -v pnpm >/dev/null 2>&1; then
  pnpm_version=$(node -p "require('./package.json').packageManager")
  corepack enable
  corepack prepare "$pnpm_version" --activate
fi
pnpm install --frozen-lockfile

sha=$(git rev-parse HEAD)
release="$releases/$sha"
if [ ! -e "$release" ]; then
  mv "$tmp/repo" "$release"
fi

ln -sfn "$release" "$root/current"
ln -sfn "$root/current/bin/needlefish" "$bin_dir/needlefish"
"$bin_dir/needlefish" --version
echo "needlefish deployed: $release"
