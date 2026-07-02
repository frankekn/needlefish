import type { Finding, Severity, Verdict } from "../../src/shared/schema";
import type { Expected, FixtureScore, MatchSpec } from "./types";

const BLOCKING: Severity[] = ["P0", "P1", "P2"];

export function matchesSpec(finding: Finding, spec: MatchSpec): boolean {
  if (spec.category && finding.category !== spec.category) return false;
  const re = new RegExp(spec.pattern, "i");
  return re.test(`${finding.title} ${finding.whyItBreaks}`);
}

function isBlocking(finding: Finding): boolean {
  return BLOCKING.includes(finding.severity);
}

// Critic prune-error: reuses matchesSpec (the recall matcher). True when a
// mustFind pattern was hit by the pre-critic candidate findings but is missing
// from the final findings — i.e. the critic deleted a correct hit. Requires
// candidateFindings (eval trace); without it, no prune is detectable.
function criticPruneError(
  candidate: readonly Finding[] | undefined,
  final: readonly Finding[],
  mustFind: readonly MatchSpec[]
): boolean {
  if (!candidate || candidate.length === 0) return false;
  return mustFind.some(
    (spec) => candidate.some((f) => matchesSpec(f, spec)) && !final.some((f) => matchesSpec(f, spec))
  );
}

function lineAnchorValid(findings: readonly Finding[], expected: Expected): boolean {
  if (!expected.anchorFile) return true;
  const range = expected.anchorLineRange;
  return findings.some((f) => {
    if (!f.file.endsWith(expected.anchorFile!)) return false;
    if (!range) return true;
    return f.lineStart >= range[0] && f.lineStart <= range[1];
  });
}

export function score(
  result: { readonly verdict: Verdict; readonly findings: readonly Finding[]; readonly candidateFindings?: readonly Finding[] } | null,
  expected: Expected,
  fixtureId: string,
  error?: string
): FixtureScore {
  if (!result) {
    return {
      fixtureId,
      verdict: null,
      verdictMatch: false,
      mustFindHits: 0,
      mustFindTotal: expected.mustFind?.length ?? 0,
      recall: false,
      falsePositive: false,
      lineAnchorValid: false,
      formatOk: false,
      findingCount: 0,
      blockingFindingCount: 0,
      criticPruneError: false,
      error,
    };
  }

  const findings = result.findings;
  const mustFind = expected.mustFind ?? [];
  const mustFindHits = mustFind.filter((spec) => findings.some((f) => matchesSpec(f, spec))).length;
  const recall = mustFind.length === 0 ? true : mustFindHits === mustFind.length;

  const falsePositive =
    (expected.mustNotFind ?? []).some((spec) => findings.some((f) => matchesSpec(f, spec))) ||
    (expected.noBlockingFindings === true && findings.some(isBlocking));

  return {
    fixtureId,
    verdict: result.verdict,
    verdictMatch: result.verdict === expected.verdict,
    mustFindHits,
    mustFindTotal: mustFind.length,
    recall,
    falsePositive,
    lineAnchorValid: lineAnchorValid(findings, expected),
    formatOk: true,
    findingCount: findings.length,
    blockingFindingCount: findings.filter(isBlocking).length,
    criticPruneError: criticPruneError(result.candidateFindings, findings, mustFind),
  };
}
