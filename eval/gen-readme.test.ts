import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadFixtures } from "./run";
import {
  fixtureClassifications,
  readLane,
  readManifest,
  validateExcludedReportFiles,
  type PublishedReport,
} from "./gen-site";
import {
  BENCHMARK_BEGIN,
  BENCHMARK_END,
  gateMissedSummary,
  renderBenchmarkBlock,
  spliceBenchmarkBlock,
} from "./gen-readme";

const manifest = readManifest();
validateExcludedReportFiles(manifest);
const lanes = manifest.lanes.map(readLane);
const canonical = fixtureClassifications(await loadFixtures(null));

for (const [file, locale] of [
  ["README.md", "en"],
  ["README.zh-TW.md", "zh-TW"],
] as const) {
  test(`${file} benchmark block is in sync`, () => {
    const source = readFileSync(file, "utf8");
    const beginIdx = source.indexOf(BENCHMARK_BEGIN);
    const endIdx = source.indexOf(BENCHMARK_END);
    assert.notEqual(beginIdx, -1, `${file} is missing ${BENCHMARK_BEGIN}`);
    assert.notEqual(endIdx, -1, `${file} is missing ${BENCHMARK_END}`);
    const actual = source.slice(beginIdx + BENCHMARK_BEGIN.length, endIdx);
    assert.equal(
      actual,
      "\n" + renderBenchmarkBlock(manifest, lanes, canonical, locale),
    );
  });
}

type SyntheticScore = {
  readonly recall: boolean;
  readonly falsePositive: boolean;
  readonly formatOk: boolean;
  readonly verdictMatch: boolean;
  readonly noiseFindingCount: number;
};

function draw(fixtureId: string, score: Partial<SyntheticScore> = {}) {
  return {
    fixtureId,
    draw: 0,
    durationMs: 1000,
    score: {
      recall: false,
      falsePositive: false,
      formatOk: true,
      verdictMatch: true,
      noiseFindingCount: 0,
      ...score,
    },
  };
}

function syntheticReport(
  results: readonly ReturnType<typeof draw>[],
): PublishedReport {
  return {
    results,
    fixtureKinds: { "t1-a": "positive", "p-b": "positive", "neg-a": "negative" },
    fixtureTiers: { "t1-a": 1, "p-b": 2 },
  } as unknown as PublishedReport;
}

const cleanNegative = draw("neg-a");
const noisyPositiveDraws = [
  ...Array.from({ length: 131 }, () => draw("p-b", { recall: true, noiseFindingCount: 1 })),
  ...Array.from({ length: 866 }, () => draw("p-b", { recall: true })),
];

test("gateMissedSummary reports a tier-1 miss only", () => {
  const report = syntheticReport([
    draw("t1-a", { recall: true }),
    draw("t1-a", { recall: true }),
    draw("t1-a"),
    cleanNegative,
  ]);
  assert.equal(gateMissedSummary(report), "Tier-1 66.67%: `t1-a` 2/3");
});

test("gateMissedSummary reports noise only", () => {
  const report = syntheticReport([
    draw("t1-a", { recall: true }),
    draw("t1-a", { recall: true }),
    draw("t1-a", { recall: true }),
    ...noisyPositiveDraws,
    cleanNegative,
  ]);
  assert.equal(gateMissedSummary(report), "noise 0.131 > 0.12");
});

test("gateMissedSummary joins tier-1 and noise misses", () => {
  const report = syntheticReport([
    draw("t1-a", { recall: true }),
    draw("t1-a", { recall: true }),
    draw("t1-a"),
    ...noisyPositiveDraws,
    cleanNegative,
  ]);
  assert.equal(
    gateMissedSummary(report),
    "Tier-1 66.67%: `t1-a` 2/3; noise 0.131 > 0.12",
  );
});

test("gateMissedSummary throws when no gate was missed", () => {
  const report = syntheticReport([
    draw("t1-a", { recall: true }),
    draw("t1-a", { recall: true }),
    draw("t1-a", { recall: true }),
    cleanNegative,
  ]);
  assert.throws(() => gateMissedSummary(report), /disqualified/);
});

test("spliceBenchmarkBlock requires exactly one marker pair", () => {
  const block = "generated\n";
  assert.throws(
    () => spliceBenchmarkBlock("no markers here", block, "README.md"),
    /README\.md/,
  );
  assert.throws(
    () =>
      spliceBenchmarkBlock(
        `${BENCHMARK_BEGIN}\n${BENCHMARK_BEGIN}\n${BENCHMARK_END}`,
        block,
        "README.zh-TW.md",
      ),
    /README\.zh-TW\.md/,
  );
  assert.throws(
    () =>
      spliceBenchmarkBlock(
        `${BENCHMARK_END}\n${BENCHMARK_BEGIN}`,
        block,
        "README.md",
      ),
    /README\.md/,
  );
  assert.throws(
    () =>
      spliceBenchmarkBlock(
        `${BENCHMARK_BEGIN}\n${BENCHMARK_END}\n${BENCHMARK_END}`,
        block,
        "README.md",
      ),
    /README\.md/,
  );
});

test("spliceBenchmarkBlock replaces the block and is idempotent", () => {
  const block = "generated block\n";
  const source = `head\n${BENCHMARK_BEGIN}\nstale\n${BENCHMARK_END}\ntail\n`;
  const once = spliceBenchmarkBlock(source, block, "README.md");
  assert.equal(once, `head\n${BENCHMARK_BEGIN}\n${block}${BENCHMARK_END}\ntail\n`);
  assert.equal(spliceBenchmarkBlock(once, block, "README.md"), once);
});
