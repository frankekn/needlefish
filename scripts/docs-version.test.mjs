import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("README Status versions match package.json", () => {
	const en = readFileSync("README.md", "utf8");
	const zh = readFileSync("README.zh-TW.md", "utf8");
	assert.match(
		en,
		new RegExp(`^## Status\\n\\nv${escaped}\\.`, "m"),
		`README.md Status must start with v${version}`,
	);
	assert.match(
		zh,
		new RegExp(`^## 狀態\\n\\nv${escaped}。`, "m"),
		`README.zh-TW.md 狀態 must start with v${version}`,
	);
});
