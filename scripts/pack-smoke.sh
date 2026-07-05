#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/needlefish-pack-smoke.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

pack_dir="$tmp/pack"
install_dir="$tmp/install"
repo="$tmp/repo"
fakebin="$tmp/bin"
home="$tmp/home"
npm_cache="$tmp/npm-cache"
mkdir -p "$pack_dir" "$install_dir" "$fakebin" "$home" "$npm_cache"
export npm_config_cache="$npm_cache"

tarball=$(cd "$root" && npm pack --pack-destination "$pack_dir" --silent | tail -1)
npm install --prefix "$install_dir" "$pack_dir/$tarball" --no-audit --no-fund --silent

node_bin=$(command -v node)
ln -s "$node_bin" "$fakebin/node"
cat > "$fakebin/claude" <<'SH'
#!/bin/sh
cat >/dev/null
printf '{"summary":"pack smoke ok","findings":[],"checked":["stub runner"],"residual_risks":[]}'
SH
chmod +x "$fakebin/claude"

git init "$repo" >/dev/null
(
  cd "$repo"
  git config user.name "Needlefish Pack Smoke"
  git config user.email "needlefish-pack-smoke@example.invalid"
  mkdir -p src
  printf 'export const value = 1;\n' > src/app.ts
  git add src/app.ts
  git commit -m init >/dev/null
  printf 'export const value = 2;\n' > src/app.ts
  printf 'export const extra = 3;\n' > src/util.ts
)

needlefish="$install_dir/node_modules/.bin/needlefish"
"$needlefish" --version
PATH="$fakebin:/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="$home" \
  NEEDLEFISH_NO_RETRY=1 \
  NEEDLEFISH_NO_FAST_PATH=1 \
  "$needlefish" --repo "$repo" --json > "$tmp/review.json"

node -e "const fs=require('node:fs'); const review=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (review.verdict !== 'pass') throw new Error('expected pass verdict'); if (!String(review.summary).includes('pack smoke ok')) throw new Error('expected stub summary');" "$tmp/review.json"
