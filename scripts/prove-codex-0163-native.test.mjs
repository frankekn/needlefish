import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("native proof checks sandbox rules before isolating its version query", { skip: process.platform !== "darwin" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "needlefish-native-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "version.json");
  const codex = join(root, "codex");
  writeFileSync(codex, `#!/usr/bin/python3
import errno,json,os,pathlib,socket
connection=socket.socket()
connection.settimeout(1)
blocked=connection.connect_ex(("1.1.1.1",443)) == errno.EPERM
pathlib.Path(${JSON.stringify(marker)}).write_text(json.dumps({"ambient":os.environ.get("NF_DUMMY_AMBIENT"),"home":os.environ.get("HOME"),"codexHome":os.environ.get("CODEX_HOME"),"externalBlocked":blocked,"homeEmpty":list(pathlib.Path(os.environ["CODEX_HOME"]).iterdir()) == []}))
print("intentionally-wrong-version")
`);
  chmodSync(codex, 0o700);
  const result = spawnSync("/usr/bin/python3", ["scripts/prove-codex-0163-native.py"], {
    encoding: "utf8",
    env: { PATH: `${root}:/usr/bin:/bin`, HOME: root, CODEX_HOME: root, NF_DUMMY_AMBIENT: "fixture-only-not-a-secret" },
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AssertionError/);
  assert.equal(result.stdout, "network: localhost allowed; external egress denied\n");
  const observed = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(observed.ambient, null);
  assert.equal(observed.home, observed.codexHome);
  assert.notEqual(observed.codexHome, root);
  assert.equal(observed.externalBlocked, true);
  assert.equal(observed.homeEmpty, true);
});
