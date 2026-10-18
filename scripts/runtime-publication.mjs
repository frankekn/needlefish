import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
export function readRuntimePublication() {
  const value = JSON.parse(readFileSync(path.join(root, "runtime-publication.json"), "utf8"));
  assert.equal(value.version, 1, "runtime-publication version");
  assert.equal(value.packageVersion, JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version, "package version differs from runtime-publication.json");
  assert.equal(value.packageDefault.selection, "auto-detect");
  assert.ok(Array.isArray(value.packageDefault.runnerPriority) && value.packageDefault.runnerPriority.every((runner) => typeof runner === "string"));
  assert.equal(typeof value.packageDefault.codexEffort, "string");
  assert.deepEqual(value.recommendedInstallation, { selection: "operator-selected", identity: "unknown", qualification: "unqualified" });
  const leaderboard = JSON.parse(readFileSync(path.join(root, "eval/leaderboard.json"), "utf8"));
  assert.deepEqual(leaderboard.lanes.filter((lane) => lane.status === "Deployed").map((lane) => lane.report), [value.benchmarkSelected.report], "benchmark selection differs from runtime-publication.json");
  return value;
}

export function runtimePublicationText(locale = "en") {
  const value = readRuntimePublication();
  const report = value.benchmarkSelected.report;
  return locale === "zh-TW"
    ? `套件 ${value.packageVersion} 依序自動偵測 ${value.packageDefault.runnerPriority.join("、")}。Codex 預設 effort 為 \`${value.packageDefault.codexEffort}\`。Benchmark 選用 [這份報告](eval/${report}) 的組態。安裝組態由操作人員選擇，身分未知，尚未完成同組態評測。Benchmark 選用不代表任何主機已部署該組態。`
    : `Package ${value.packageVersion} auto-detects ${value.packageDefault.runnerPriority.join(", ")} in order. Codex defaults to \`${value.packageDefault.codexEffort}\` effort. The benchmark selects the configuration in [this report](eval/${report}). The operator selects the installation configuration. Its identity is unknown and unqualified. Benchmark selection does not establish what any host has deployed.`;
}

export function siteRuntimePublicationBlock() {
  const value = readRuntimePublication();
  const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const note = `Package ${escapeHtml(value.packageVersion)} uses ${escapeHtml(value.packageDefault.selection)}. Installed configurations are operator-selected, with unknown identity and no exact qualification claim. Auto-detection tries ${value.packageDefault.runnerPriority.map(escapeHtml).join(", ")} in order. Codex defaults to ${escapeHtml(value.packageDefault.codexEffort)} effort. Benchmark-selected report: <a href="https://github.com/frankekn/needlefish/blob/main/eval/${escapeHtml(value.benchmarkSelected.report)}">${escapeHtml(value.benchmarkSelected.report)}</a>. Benchmark selection does not establish what any host has deployed.`;
  return `<!-- runtime-publication:begin -->\n<p>${note}</p>\n<!-- runtime-publication:end -->`;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const write = process.argv.includes("--write");
  for (const [file, locale] of [["README.md", "en"], ["README.zh-TW.md", "zh-TW"], ["docs/index.html", "site"]]) {
    const target = path.join(root, file);
    const source = readFileSync(target, "utf8");
    const begin = "<!-- runtime-publication:begin -->";
    const end = "<!-- runtime-publication:end -->";
    const block = locale === "site" ? siteRuntimePublicationBlock() : `${begin}\n${runtimePublicationText(locale)}\n${end}`;
    const start = source.indexOf(begin);
    const finish = source.indexOf(end);
    assert.ok(start >= 0 && finish > start && source.indexOf(begin, start + begin.length) < 0 && source.indexOf(end, finish + end.length) < 0, `${file} runtime publication markers`);
    const generated = source.slice(0, start) + block + source.slice(finish + end.length);
    if (write) writeFileSync(target, generated);
    else assert.ok(source === generated, `${file}: run node scripts/runtime-publication.mjs --write`);
  }
}
