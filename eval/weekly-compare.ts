import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCompleteReport } from "./shared/report-completeness";
import {
  hasConsistentCheatDetection,
  hasCurrentScorer,
} from "./shared/report-integrity";
import { ANTICHEAT_VERSION, type Report } from "./shared/types";

// Weekly regression verdict. Built around the noise floor of this eval: with
// ~20 positives, one fixture is ~5pp of recall and single draws flicker, so
// an aggregate-recall threshold pages on noise. Instead we alert on STABLE
// per-fixture regressions (hit on all draws last week, missed on all draws
// this week), which single-draw variance cannot produce at draws>=3.

const MIN_WEEKLY_DRAWS = 3;

export interface WeeklyVerdict {
  readonly alert: boolean;
  readonly reasons: readonly string[];
  // Set when the latest report's trap fired: its numbers are void and no
  // consumer may print or act on them.
  readonly compromised?: boolean;
  // Set when the latest report did not run under the current anti-cheat
  // generation: its numbers are unguarded and must be withheld too.
  readonly unguarded?: boolean;
  // Set when the latest report lacks exact fixture-by-draw coverage: partial
  // rows cannot support any metric or stability conclusion.
  readonly incomplete?: boolean;
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
  // Reports come from unvalidated JSON: only an exact count of ZERO
  // establishes a clean report (same contract as gen-results' `=== 0`).
  // Missing fails closed; so does any other value — a negative or NaN count
  // is malformed, and the CHEAT branch above only caught > 0. Read through a
  // widened type — the schema says number, the disk may disagree.
  const latestCheatCount: number | undefined =
    latest.aggregates.cheatDetectedCount;
  if (
    latest.anticheatVersion !== ANTICHEAT_VERSION ||
    !hasCurrentScorer(latest) ||
    typeof latestCheatCount !== "number" ||
    latestCheatCount !== 0 ||
    !hasConsistentCheatDetection(latest)
  ) {
    // Not proven void (unlike CHEAT), but unguarded: the current generation's
    // detection never covered (or never recorded) these draws, so no metric
    // may be published and the weekly lane itself needs fixing — that is
    // alert-worthy on its own.
    return {
      alert: true,
      unguarded: true,
      reasons: [
        `latest report anti-cheat generation is ${latest.anticheatVersion ?? "none"} (current is ${ANTICHEAT_VERSION}), scorerHash is ${latest.scorerHash ?? "none"}, or its cheatDetectedCount is missing or invalid — metrics withheld; re-run the weekly lane under the current guards`,
      ],
    };
  }
  if (!isCompleteReport(latest) || latest.draws < MIN_WEEKLY_DRAWS) {
    return {
      alert: true,
      incomplete: true,
      reasons: [
        "latest report fixture/draw coverage is incomplete or has fewer than 3 draws — metrics withheld; re-run the weekly lane",
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
      // compare() in run.ts): the previous week must have run under the
      // CURRENT generation, same as the latest (gated above), not merely a
      // matching obsolete one. A missing cheatDetectedCount fails closed too
      // — absence of the canary result cannot establish a clean report —
      // and so does a negative/NaN count (malformed; only >0 means a fired
      // trap, which the compromised branch below reports as CHEAT).
      prev.anticheatVersion !== ANTICHEAT_VERSION ||
      !hasCurrentScorer(prev) ||
      typeof (prev.aggregates.cheatDetectedCount as number | undefined) !==
        "number" ||
      prev.aggregates.cheatDetectedCount < 0 ||
      Number.isNaN(prev.aggregates.cheatDetectedCount)
    ) {
      // Different prompt, fixture set, or guard generation: week-over-week
      // deltas are meaningless.
      return { alert: reasons.length > 0, reasons: [...reasons, "note: prompt/fixture set/anti-cheat generation/scorer changed since last week (or previous cheatDetectedCount is missing/invalid); skipping regression comparison"] };
    }
    if (prev.aggregates.cheatDetectedCount > 0) {
      // A fired trap voids the whole report — void numbers must not produce
      // or suppress regression conclusions. (A compromised LATEST report
      // already returned at the top with CHEAT as the only reason.)
      return { alert: reasons.length > 0, reasons: [...reasons, "note: a compromised report (cheatDetectedCount>0) blocks the week-over-week comparison"] };
    }
    if (!hasConsistentCheatDetection(prev)) {
      return {
        alert: reasons.length > 0,
        reasons: [
          ...reasons,
          "note: previous report has inconsistent anti-cheat detections; skipping regression comparison",
        ],
      };
    }
    if (!isCompleteReport(prev) || prev.draws < MIN_WEEKLY_DRAWS) {
      return {
        alert: reasons.length > 0,
        reasons: [
          ...reasons,
          "note: previous report fixture/draw coverage is incomplete or has fewer than 3 draws; skipping regression comparison",
        ],
      };
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
  let latest: Report;
  let prev: Report | null;
  try {
    latest = JSON.parse(readFileSync(latestPath, "utf8")) as Report;
    prev = prevPath ? (JSON.parse(readFileSync(prevPath, "utf8")) as Report) : null;
  } catch (error) {
    process.stderr.write(`weekly-compare: could not read report: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  const verdict = compareWeekly(prev, latest);
  const a = latest.aggregates;
  // A compromised report's numbers are void, an unguarded one's unprotected,
  // and an incomplete one's insufficient: print only the reasons, never the
  // aggregate or tier metric lines.
  const metricLines = verdict.compromised || verdict.unguarded || verdict.incomplete
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
