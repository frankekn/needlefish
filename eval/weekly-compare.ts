import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "./shared/types";

// Weekly regression verdict. Built around the noise floor of this eval: with
// ~20 positives, one fixture is ~5pp of recall and single draws flicker, so
// an aggregate-recall threshold pages on noise. Instead we alert on STABLE
// per-fixture regressions (hit on all draws last week, missed on all draws
// this week), which single-draw variance cannot produce at draws>=3.

export interface WeeklyVerdict {
  readonly alert: boolean;
  readonly reasons: readonly string[];
  // Set when the latest report's trap fired: its numbers are void and no
  // consumer may print or act on them.
  readonly compromised?: boolean;
}

function stableRecallByFixture(report: Report): Map<string, "hit" | "miss" | "mixed"> {
  const byFixture = new Map<string, boolean[]>();
  for (const r of report.results) {
    const arr = byFixture.get(r.fixtureId) ?? [];
    arr.push(r.score.recall);
    byFixture.set(r.fixtureId, arr);
  }
  const out = new Map<string, "hit" | "miss" | "mixed">();
  for (const [id, draws] of byFixture) {
    out.set(id, draws.every(Boolean) ? "hit" : draws.some(Boolean) ? "mixed" : "miss");
  }
  return out;
}

function stableFpFixtures(report: Report): Set<string> {
  const byFixture = new Map<string, boolean[]>();
  for (const r of report.results) {
    const arr = byFixture.get(r.fixtureId) ?? [];
    arr.push(r.score.falsePositive);
    byFixture.set(r.fixtureId, arr);
  }
  return new Set([...byFixture].filter(([, draws]) => draws.every(Boolean)).map(([id]) => id));
}

export function compareWeekly(prev: Report | null, latest: Report): WeeklyVerdict {
  const reasons: string[] = [];

  if (latest.aggregates.cheatDetectedCount > 0) {
    // A fired trap voids the WHOLE report: no other metric conclusion may be
    // derived from it. CHEAT is the only substantive reason.
    return {
      alert: true,
      compromised: true,
      reasons: [
        `CHEAT: honeypot trap fired in ${latest.aggregates.cheatDetectedCount} draw(s) — report compromised, investigate runner sandbox`,
        "note: all other metrics withheld — a compromised report's numbers are void",
      ],
    };
  }
  if (latest.aggregates.invalidJsonRate > 0.1) {
    reasons.push(`invalidJsonRate ${(latest.aggregates.invalidJsonRate * 100).toFixed(0)}% exceeds 10%`);
  }

  // Tier-1 misses are disqualifying on their own — checked against the latest
  // report alone so the very first run (or the first after a prompt/fixture
  // change) still pages when a blatant-bug fixture is stably missed.
  const latestStableAll = stableRecallByFixture(latest);
  const latestTiers = latest.fixtureTiers ?? {};
  const t1Missed = [...latestStableAll]
    .filter(([id, state]) => state === "miss" && latestTiers[id] === 1)
    .map(([id]) => id);
  if (t1Missed.length > 0) {
    reasons.push(`tier-1 fixtures stably missed (disqualifying): ${t1Missed.join(", ")}`);
  }

  if (prev) {
    if (
      prev.promptHash !== latest.promptHash ||
      !prev.fixtureSetHash ||
      !latest.fixtureSetHash ||
      prev.fixtureSetHash !== latest.fixtureSetHash ||
      // Cross-anti-cheat-generation draws are declared incomparable (see
      // compare() in run.ts): a pre-guard week must not anchor a guarded one.
      prev.anticheatVersion !== latest.anticheatVersion ||
      prev.anticheatVersion === undefined
    ) {
      // Different prompt, fixture set, or guard generation: week-over-week
      // deltas are meaningless.
      return { alert: reasons.length > 0, reasons: [...reasons, "note: prompt/fixture set/anti-cheat generation changed since last week; skipping regression comparison"] };
    }
    if (prev.aggregates.cheatDetectedCount > 0) {
      // A fired trap voids the whole report — void numbers must not produce
      // or suppress regression conclusions. (A compromised LATEST report
      // already returned at the top with CHEAT as the only reason.)
      return { alert: reasons.length > 0, reasons: [...reasons, "note: a compromised report (cheatDetectedCount>0) blocks the week-over-week comparison"] };
    }
    const prevStable = stableRecallByFixture(prev);
    const regressed = [...latestStableAll]
      .filter(([id, state]) => state === "miss" && prevStable.get(id) === "hit")
      .map(([id]) => id);
    if (regressed.length >= 2) {
      reasons.push(`${regressed.length} fixtures regressed from stable-hit to stable-miss: ${regressed.join(", ")}`);
    }
    const newFp = [...stableFpFixtures(latest)].filter((id) => !stableFpFixtures(prev).has(id));
    if (newFp.length > 0) {
      reasons.push(`new stable false positive(s): ${newFp.join(", ")}`);
    }
  }

  return { alert: reasons.length > 0, reasons };
}

function main(): void {
  const [latestPath, prevPath] = process.argv.slice(2);
  if (!latestPath) {
    process.stderr.write("usage: weekly-compare.ts <latest.json> [prev.json]\n");
    process.exit(1);
  }
  const latest = JSON.parse(readFileSync(latestPath, "utf8")) as Report;
  const prev = prevPath ? (JSON.parse(readFileSync(prevPath, "utf8")) as Report) : null;
  const verdict = compareWeekly(prev, latest);
  const a = latest.aggregates;
  // A compromised report's numbers are void: print only the reasons (CHEAT
  // + withholding note), never the aggregate or tier metric lines.
  const metricLines = verdict.compromised
    ? []
    : [
        `recall ${(a.recall * 100).toFixed(0)}% | fp ${(a.falsePositiveRate * 100).toFixed(0)}% | verdict ${(a.verdictMatchRate * 100).toFixed(0)}% | noise ${a.meanNoisePerPositive.toFixed(1)}/positive`,
        ...Object.entries(a.recallByTier).map(([t, v]) => `recall ${t}: ${(v * 100).toFixed(0)}%`),
      ];
  process.stdout.write([...metricLines, ...verdict.reasons].join("\n") + "\n");
  // exit 2 = alert (workflow opens an issue with the stdout above), 0 = fine.
  process.exit(verdict.alert ? 2 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
