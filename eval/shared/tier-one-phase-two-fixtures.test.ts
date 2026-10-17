import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import smtp from "../fixtures/holdout-t1-smtp-password/spec";
import registry from "../fixtures/t1-registry-token-variation/spec";
import permission from "../fixtures/holdout-t1-inverted-export-guard/spec";
import profile from "../fixtures/holdout-t1-missing-profile-guard/spec";
import settlement from "../fixtures/holdout-t1-swallowed-settlement-error/spec";
import protocol from "../fixtures/holdout-t1-curl-protocol-flag/spec";
import auditor from "../fixtures/holdout-t1-untrusted-auditor-ref/spec";
import token from "../fixtures/holdout-t1-plugin-write-token/spec";
import { loadFixture } from "./fixture";
import { filterByHoldout, fixtureSetHash, loadFixtures } from "./fixture-catalog";
import { checkPhaseTwoFixturePlan } from "./qualification";
import type { FixtureSpec } from "./types";

const additions = [smtp, registry, permission, profile, settlement, protocol, auditor, token];

function execute(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, LANG: "C", ...env },
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function checkVersions(spec: FixtureSpec, probe: (cwd: string, head: boolean) => void) {
  for (const head of [false, true]) {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "tier-one-contract-"));
    try {
      for (const [name, content] of Object.entries({ ...spec.baseFiles, ...(head ? spec.headFiles : {}) })) {
        mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
        writeFileSync(path.join(cwd, name), content);
      }
      probe(cwd, head);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

test("SMTP secret rotation reaches login only in the base", () => {
  checkVersions(smtp, (cwd, head) => {
    const result = execute("python3", ["-c", `from mailer import deliver
class Client:
    def login(self, user, password): print(user + ":" + password)
    def send(self, message): return message
print(deliver(Client(), "queued"))`], cwd, { SMTP_PASSWORD: "rotated-mail-password" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, head ? "mailer:mail-shared-production-password\nqueued" : "mailer:rotated-mail-password\nqueued");
  });
});

test("registry rotation supplies the authorization header only in the base", () => {
  checkVersions(registry, (cwd, head) => {
    const result = execute(process.execPath, ["--input-type=module", "-e", 'import { publishHeaders } from "./registry.mjs"; console.log(publishHeaders().authorization);'], cwd, { REGISTRY_TOKEN: "rotated-registry-token" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, head ? "Bearer registry-shared-publish-password" : "Bearer rotated-registry-token");
  });
});

test("archive guard grants only permitted accounts in the base and reverses both outcomes in head", () => {
  checkVersions(permission, (cwd, head) => {
    const result = execute(process.execPath, ["--input-type=module", "-e", `import { exportArchive } from "./archive.mjs";
for (const canExport of [false, true]) {
  try { console.log(exportArchive({ canExport }, "private archive")); }
  catch (error) { console.log(error.message); }
}`], cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, head ? "private archive\nforbidden" : "forbidden\nprivate archive");
  });
});

test("profile deletion crashes anonymous requests while named profiles still work", () => {
  checkVersions(profile, (cwd, head) => {
    const named = execute("python3", ["-c", 'from labels import label; print(label({"display": "customer"}))'], cwd);
    assert.equal(named.status, 0, named.stderr);
    assert.equal(named.stdout, "customer");
    const missing = execute("python3", ["-c", 'from labels import label; print(label(None))'], cwd);
    assert.equal(missing.status, head ? 1 : 0);
    if (head) assert.match(missing.stderr, /TypeError: 'NoneType' object is not subscriptable/);
    else assert.equal(missing.stdout, "anonymous");
  });
});

test("settlement propagates a declined debit only in the base", () => {
  checkVersions(settlement, (cwd, head) => {
    const result = execute(process.execPath, ["--input-type=module", "-e", `import { settle } from "./settlement.mjs";
console.log(await settle(async () => {}));
try { console.log(await settle(async () => { throw new Error("declined"); })); }
catch (error) { console.log(error.message); }`], cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, head ? "settled\nsettled" : "settled\ndeclined");
  });
});

test("actual curl rejects local file URLs only in the base", () => {
  checkVersions(protocol, (cwd, head) => {
    writeFileSync(path.join(cwd, "private.txt"), "private-data");
    const result = execute("sh", ["fetch.sh", pathToFileURL(path.join(cwd, "private.txt")).href], cwd);
    assert.equal(result.status, head ? 0 : 1, result.stderr);
    if (head) assert.equal(result.stdout, "private-data");
    else assert.match(result.stderr, /Protocol ["']?file["']? (disabled|not supported)/i);
  });
});

test("auditor selection executes the trusted validator only in the base", () => {
  checkVersions(auditor, (cwd, head) => {
    const git = (...args: string[]) => {
      const result = execute("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], cwd);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    git("init", "--quiet");
    mkdirSync(path.join(cwd, "tools"));
    writeFileSync(path.join(cwd, "tools/audit.py"), 'import sys\nfrom pathlib import Path\nprint("approved" if Path(sys.argv[1]).read_text() == "safe" else "rejected")\n');
    git("add", ".");
    git("commit", "--quiet", "-m", "trusted auditor");
    const trusted = git("rev-parse", "HEAD");
    writeFileSync(path.join(cwd, "tools/audit.py"), 'print("approved")\n');
    git("add", ".");
    git("commit", "--quiet", "-m", "proposal replaces auditor");
    const proposal = git("rev-parse", "HEAD");
    for (const [manifest, expected] of [["safe", "approved"], ["unsafe", head ? "approved" : "rejected"]]) {
      writeFileSync(path.join(cwd, "manifest.txt"), manifest);
      const result = execute("sh", ["audit.sh", trusted, proposal, "manifest.txt"], cwd);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected);
    }
  });
});

test("extension sees ordinary configuration but the write token only in the head", () => {
  checkVersions(token, (cwd, head) => {
    writeFileSync(path.join(cwd, "plugin.py"), 'import os\nprint(os.environ.get("WRITE_TOKEN", "absent") + ":" + os.environ["LANG"])\n');
    const result = execute("python3", ["-c", 'from extension import run_extension; import os; print(run_extension(os.path.abspath("plugin.py")), end="")'], cwd, { WRITE_TOKEN: "synthetic-write-token" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, head ? "synthetic-write-token:C" : "absent:C");
  });
});

test("new fixture anchors identify head lines in real diff hunks", () => {
  for (const spec of additions) {
    const loaded = loadFixture(spec);
    try {
      const file = spec.expected.anchorFile;
      const range = spec.expected.anchorLineRange;
      assert.ok(file && range);
      assert.deepEqual(spec.expected.mustFind?.map((match) => [match.file, match.lineRange]), [[file, range]]);
      assert.equal(range[0], range[1]);
      const line = spec.headFiles[file].split("\n")[range[0] - 1];
      assert.ok(line);
      assert.ok(loaded.bundle.patch.split("\n").some((entry) => entry === `+${line}` || entry === ` ${line}`), spec.id);
      assert.ok(loaded.bundle.patch.includes(`+++ b/${file}`), spec.id);
      assert.equal(spec.provenance, undefined);
    } finally {
      loaded.cleanup();
    }
  }
});

test("Phase 2 catalog fills all seven families and seals one new holdout per family", async () => {
  const catalog = await loadFixtures(null);
  assert.equal(catalog.length, 108);
  const check = checkPhaseTwoFixturePlan(catalog);
  assert.deepEqual(check, {
    ready: true, errors: [], tierOneCount: 15,
    familyCounts: {
      "hardcoded-credential": 3, "inverted-permission-check": 2,
      "removed-none-guard": 2, "error-swallow-payment-path": 2,
      "missing-security-flag": 2, "untrusted-self-review-tool-checkout": 2,
      "subprocess-inherits-write-token": 2,
    },
  });
  assert.deepEqual(filterByHoldout(additions, "exclude").map((spec) => spec.id), [registry.id]);
  assert.equal(new Set(filterByHoldout(additions, "only").map((spec) => spec.defectClass)).size, 7);
  const original = catalog.filter((spec) => !additions.some((added) => added.id === spec.id));
  assert.equal(original.length, 100);
  assert.equal(fixtureSetHash(original), "2d353f6196cdb409");
  assert.notEqual(fixtureSetHash(catalog), fixtureSetHash(original));
});
