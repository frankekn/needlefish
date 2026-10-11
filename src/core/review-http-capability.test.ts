import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { review } from "./review.js";
import type { Bundle } from "../shared/schema.js";

const bundle: Bundle = {
  repoPath: "/unused/http-target", baseSha: "base", headSha: "head",
  patch: "diff --git a/app.ts b/app.ts\n+export const value = 2;\n",
  patchStat: " app.ts | 1 +", changedFiles: [{ path: "app.ts", surface: "source" }],
  agentsMd: "(none)", prMeta: null, deep: false, focus: null,
};

test("tool-less HTTP runner rejects deep and automatically large reviews before sending requests", async (t) => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      summary: "reviewed", findings: [], checked: ["checked"], residual_risks: [],
    }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const keys = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "NEEDLEFISH_RUNNER", "NEEDLEFISH_LARGE_PATCH_CHARS", "NEEDLEFISH_LARGE_FILE_COUNT", "NEEDLEFISH_NO_FAST_PATH"];
  const previous = keys.map((key) => process.env[key]);
  t.after(async () => {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "local-test-placeholder";
  process.env.NEEDLEFISH_RUNNER = "openai";
  process.env.NEEDLEFISH_LARGE_PATCH_CHARS = "30000";
  process.env.NEEDLEFISH_LARGE_FILE_COUNT = "10";
  delete process.env.NEEDLEFISH_NO_FAST_PATH;
  const unsupported = /openai HTTP runner cannot inspect repository files/;
  await assert.rejects(review({ ...bundle, deep: true }, { runner: "openai", model: "probe" }), unsupported);
  await assert.rejects(review({ ...bundle, patch: bundle.patch.repeat(1000) }, { model: "probe" }), unsupported);
  await assert.rejects(review({ ...bundle, changedFiles: Array.from({ length: 11 }, (_, i) => ({ path: `app${i}.ts`, surface: "source" })) }, { model: "probe" }), unsupported);
  assert.equal(requests, 0);
  assert.equal((await review({ ...bundle, deep: true, changedFiles: [{ path: "README.md", surface: "docs" }] }, { runner: "openai" })).verdict, "pass");
  assert.equal(requests, 0);
  const small = await review(bundle, { runner: "openai", model: "probe" });
  assert.equal(small.verdict, "pass");
  assert.equal(requests, 2);
});
