#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const [base, ...extra] = process.argv.slice(2);
const timeoutMs = Number(process.env.NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS ?? 1_200_000);
if (!base || extra.length) {
  process.stderr.write("Usage: node .needlefish/shift-left/review-gate.mjs <base-ref>\n");
  process.exit(1);
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
  process.stderr.write("Needlefish gate blocked: NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS must be an integer between 1 and 2147483647 milliseconds\n");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "needlefish-pre-pr-"));
const file = join(dir, "result.json");
const deadline = Date.now() + timeoutMs;
let active;
let diagnostics = "";
let outputBytes = 0;
function stop() {
  if (active?.pid) {
    try { process.kill(-active.pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stop();
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });
}

async function run(args) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("review deadline expired");
  return await new Promise((resolve, reject) => {
    const child = spawn("needlefish", args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    active = child;
    let stdout = "";
    let stderr = "";
    let failure;
    const timer = setTimeout(() => {
      failure = new Error("review deadline expired");
      stop();
    }, remaining);
    for (const [stream, append] of [
      [child.stdout, (text) => { stdout += text; }],
      [child.stderr, (text) => {
        stderr += text;
        diagnostics += text.slice(0, Math.max(0, 16_384 - diagnostics.length));
      }],
    ]) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk) => {
        outputBytes += chunk.length;
        append(decoder.write(chunk));
        if (outputBytes > 8_000_000 && !failure) {
          failure = new Error("review output exceeds 8 MB");
          stop();
        }
      });
      stream.on("end", () => append(decoder.end()));
    }
    child.on("error", (error) => { failure = error; });
    child.on("close", (status) => {
      clearTimeout(timer);
      stop();
      active = undefined;
      if (failure) reject(failure);
      else resolve({ status, stdout, stderr });
    });
  });
}

try {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (process.env.NEEDLEFISH_SHIFT_LEFT_EXPECTED_HEAD &&
      process.env.NEEDLEFISH_SHIFT_LEFT_EXPECTED_HEAD !== head) {
    throw new Error("checked-out HEAD differs from the pushed commit");
  }
  const baseSha = execFileSync("git", ["merge-base", base, head], { encoding: "utf8" }).trim();
  const review = await run(["--repo", process.cwd(), "--branch", "--base", base, "--json"]);
  writeFileSync(file, review.stdout, { mode: 0o600 });
  let data;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch {
    throw new Error("review output is not valid JSON");
  }
  const verdict = data?.verdict;
  if (!["pass", "changes_requested", "needs_human"].includes(verdict)) {
    throw new Error("review has no recognized verdict");
  }
  const expected = verdict === "pass" ? 0 : 1;
  const acceptedStatuses = expected === 0 ? [0] : [0, 1];
  const validated = await run(["verdict", file]);
  if (!acceptedStatuses.includes(validated.status) || validated.stderr ||
      validated.stdout !== `stored:  ${verdict}\nderived: ${verdict}\n`) {
    throw new Error("review schema or derived verdict validation failed");
  }
  if (!acceptedStatuses.includes(review.status)) throw new Error("review exit status disagrees with its verdict");
  if (data.headSha !== head || data.baseSha !== baseSha ||
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== head ||
      execFileSync("git", ["merge-base", base, head], { encoding: "utf8" }).trim() !== baseSha) {
    throw new Error("review does not match the current branch and base");
  }
  const rendered = await run(["render", file]);
  if (!acceptedStatuses.includes(rendered.status) || rendered.stderr) throw new Error("review rendering failed");
  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== head ||
      execFileSync("git", ["merge-base", base, head], { encoding: "utf8" }).trim() !== baseSha) {
    throw new Error("HEAD or base changed during review");
  }
  process.stdout.write(rendered.stdout);
  if (diagnostics) process.stderr.write(diagnostics);
  process.exitCode = expected;
} catch (error) {
  if (diagnostics) process.stderr.write(diagnostics.endsWith("\n") ? diagnostics : `${diagnostics}\n`);
  process.stderr.write(`Needlefish gate blocked: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  stop();
  rmSync(dir, { recursive: true, force: true });
}
