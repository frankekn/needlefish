import assert from "node:assert/strict";
import test from "node:test";
import { publicLabel } from "./publication";

test("publicLabel removes private gateway names from published text", () => {
  const examples = [
    ["via CLIProxyAPI", "via private gateway"],
    ["via Magpie", "via private gateway"],
    ["VIA cLiPrOxYaPi", "via private gateway"],
    ["CLIProxyAPI", "private gateway"],
    ["Magpie", "private gateway"],
    [
      "cliproxy-deepseek/deepseek-v4-flash-vision-exp",
      "deepseek/deepseek-v4-flash-vision-exp",
    ],
    ["PI_PROVIDER=cliproxy-claude", "PI_PROVIDER=claude"],
    ["PI_PROVIDER=magpie-claude", "PI_PROVIDER=claude"],
    ["zai-cliproxy", "zai"],
    ["PI_PROVIDER=magpie", "PI_PROVIDER=gateway"],
    ["cliproxyapi/CF-Qwen", "CF-Qwen"],
  ] as const;

  for (const [value, expected] of examples) {
    const actual = publicLabel(value);
    assert.equal(actual, expected);
    assert.doesNotMatch(actual, /cliproxy|magpie/i);
  }
});

test("publicLabel leaves unrelated publication text byte-identical", () => {
  const value = "Codex CLI v1.2.3 via public API";
  assert.equal(publicLabel(value), value);
});
