#!/bin/sh
set -eu

NEEDLEFISH_REPO_URL="${NEEDLEFISH_REPO_URL:-https://github.com/frankekn/needlefish.git}"
NEEDLEFISH_REF="${NEEDLEFISH_REF:-main}"
root="$HOME/.local/share/needlefish"
releases="$root/releases"
bin_dir="$HOME/.local/bin"

mkdir -p "$releases" "$bin_dir"
tmp=$(mktemp -d "$releases/.tmp.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

validate_release() {
	if [ ! -f "$release/release.json" ]; then
		echo "existing release is missing release.json: $release" >&2
		exit 1
	fi
	node - "$release/release.json" "$sha" <<'NODE'
const metadata = require(process.argv[2]);
const expectedSha = process.argv[3];
for (const key of ["sha", "version", "repoUrl", "deployedAt", "node"]) {
  if (!metadata[key]) process.exit(1);
}
if (metadata.sha !== expectedSha) process.exit(1);
NODE
	"$release/bin/needlefish" --version
}

git init "$tmp/repo"
cd "$tmp/repo"
git remote add origin "$NEEDLEFISH_REPO_URL"
git fetch --depth 1 origin "$NEEDLEFISH_REF"
git checkout --detach FETCH_HEAD

sha=$(git rev-parse HEAD)
release="$releases/$sha"
if [ -e "$release" ]; then
	validate_release
else
	if command -v pnpm >/dev/null 2>&1; then
		pnpm install --frozen-lockfile
	else
		corepack pnpm install --frozen-lockfile
	fi

	version=$(node -p "require('./package.json').version")
	node_version=$(node -p "process.version")
	deployed_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	node - "$tmp/repo/release.json" "$sha" "$version" "$NEEDLEFISH_REPO_URL" "$deployed_at" "$node_version" <<'NODE'
const fs = require("node:fs");
const [path, sha, version, repoUrl, deployedAt, node] = process.argv.slice(2);
fs.writeFileSync(path, `${JSON.stringify({ sha, version, repoUrl, deployedAt, node }, null, 2)}\n`);
NODE
	"$tmp/repo/bin/needlefish" --version
	if ! mv "$tmp/repo" "$release"; then
		validate_release
	fi
fi

# Keep the last-known-good install one symlink away: the canary window armed
# at each deploy rolls back by repointing "current" at "previous".
previous_target=""
if [ -L "$root/current" ]; then
	previous_target=$(readlink "$root/current")
fi
ln -sfn "$release" "$root/current"
if [ -n "$previous_target" ] && [ "$previous_target" != "$release" ]; then
	ln -sfn "$previous_target" "$root/previous"
else
	second=$(ls -dt "$releases"/* 2>/dev/null | sed -n 2p)
	if [ -n "$second" ] && [ "$second" != "$release" ]; then
		ln -sfn "$second" "$root/previous"
	fi
fi
ln -sfn "$root/current/bin/needlefish" "$bin_dir/needlefish"
echo "needlefish deployed: $release"
if [ -e "$root/previous" ]; then
	echo "canary rollback point: $(readlink "$root/previous") (repoint $root/current at it to roll back)"
fi
