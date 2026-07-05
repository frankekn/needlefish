import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function installFakeClaude(t: TestContext, tmp: string): { readonly promptPath: string } {
  const promptPath = join(tmp, "prompts.txt");
  const bin = join(tmp, "claude-bin.js");
  const previous = {
    bin: process.env.CLAUDE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
    noFastPath: process.env.NEEDLEFISH_NO_FAST_PATH,
    noRetry: process.env.NEEDLEFISH_NO_RETRY,
  };
  t.after(() => {
    restoreEnv("CLAUDE_BIN", previous.bin);
    restoreEnv("NEEDLEFISH_RUNNER", previous.runner);
    restoreEnv("NEEDLEFISH_NO_FAST_PATH", previous.noFastPath);
    restoreEnv("NEEDLEFISH_NO_RETRY", previous.noRetry);
  });
  writeFakeClaude(bin, promptPath);
  process.env.CLAUDE_BIN = bin;
  process.env.NEEDLEFISH_RUNNER = "claude";
  process.env.NEEDLEFISH_NO_FAST_PATH = "1";
  process.env.NEEDLEFISH_NO_RETRY = "1";
  return { promptPath };
}

export function fakeClaudeEnv(bin: string, home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_BIN: bin,
    HOME: home,
    NEEDLEFISH_NO_FAST_PATH: "1",
    NEEDLEFISH_NO_RETRY: "1",
  };
}

export function writeFakeClaude(bin: string, promptPath: string): void {
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      `  fs.appendFileSync(${JSON.stringify(promptPath)}, '\\n---PROMPT---\\n' + prompt);`,
      "  process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['checked'], residual_risks: [] }));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
}
