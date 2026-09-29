import assert from "node:assert/strict";
import test from "node:test";
import { deriveVerdict } from "../core/verdict";
import { isNeedlefishPost, normalizeBodyList, normalizeFinding, normalizeMap, normalizePrMeta, normalizeReview } from "./normalize";

test("normalizeMap accepts a summary with no hotspots", () => {
  const map = normalizeMap({ summary: "reviewed", hotspots: [] });

  assert.deepEqual(map, { summary: "reviewed", hotspots: [] });
});

test("normalizeMap keeps a complete hotspot with normalized edges", () => {
  const map = normalizeMap({
    summary: "reviewed",
    hotspots: [
      {
        name: "API boundary",
        files: ["src/api.ts"],
        why: "Shared input validation.",
        risk: "high",
        edges: [
          {
            producer: "src/api.ts",
            consumerFile: "src/app.ts",
            consumerLine: "42",
            why: "The app consumes the parsed shape.",
          },
        ],
      },
    ],
  });

  assert.deepEqual(map.hotspots, [
    {
      name: "API boundary",
      files: ["src/api.ts"],
      why: "Shared input validation.",
      risk: "high",
      edges: [
        {
          producer: "src/api.ts",
          consumerFile: "src/app.ts",
          consumerLine: 42,
          why: "The app consumes the parsed shape.",
        },
      ],
    },
  ]);
});

test("normalizeMap rejects missing or invalid summary", () => {
  for (const raw of [
    null,
    { hotspots: [] },
    { summary: 1, hotspots: [] },
  ]) {
    assert.throws(() => normalizeMap(raw), /malformed map output/);
  }
});

test("normalizeMap drops hotspots without files", () => {
  const map = normalizeMap({
    summary: "reviewed",
    hotspots: [
      { name: "missing files", files: [], risk: "high" },
      { name: "kept", files: ["src/app.ts"], risk: "low" },
    ],
  });

  assert.deepEqual(map.hotspots.map((hotspot) => hotspot.name), ["kept"]);
});

test("normalizeMap defaults invalid hotspot risk to med", () => {
  const map = normalizeMap({
    summary: "reviewed",
    hotspots: [
      { name: "risky", files: ["src/app.ts"], risk: "critical" },
    ],
  });

  assert.equal(map.hotspots[0]?.risk, "med");
});

test("normalizeMap drops edges missing consumerFile", () => {
  const map = normalizeMap({
    summary: "reviewed",
    hotspots: [
      {
        name: "edge case",
        files: ["src/app.ts"],
        edges: [
          { producer: "src/app.ts", why: "missing consumer file" },
          { producer: "src/app.ts", consumerFile: "src/ui.ts", why: "kept" },
        ],
      },
    ],
  });

  assert.deepEqual(map.hotspots[0]?.edges, [
    {
      producer: "src/app.ts",
      consumerFile: "src/ui.ts",
      consumerLine: 0,
      why: "kept",
    },
  ]);
});

test("normalizeMap truncates long hotspot names", () => {
  const longName = "x".repeat(100);
  const map = normalizeMap({
    summary: "reviewed",
    hotspots: [
      { name: longName, files: ["src/app.ts"] },
    ],
  });

  assert.equal(map.hotspots[0]?.name.length, 80);
  assert.equal(map.hotspots[0]?.name, "x".repeat(80));
});

test("normalizePrMeta accepts complete PR metadata", () => {
  const meta = normalizePrMeta({
    number: 12,
    title: "Fix parser",
    body: "Body text",
    comments: [" comment "],
    reviews: [{ body: " review " }],
    statusCheckRollup: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { context: "lint", status: "PENDING", conclusion: null },
    ],
  });

  assert.deepEqual(meta, {
    number: 12,
    title: "Fix parser",
    body: "Body text",
    comments: ["comment"],
    reviews: ["review"],
    checks: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "lint", status: "PENDING", conclusion: null },
    ],
  });
});

// Bodies sampled from this repo's PRs 182, 198 and 200 via the reviews and
// comments APIs, cut to the lines that carry the shape.
const OWN_ROUND_COMMENT =
  "**Needlefish re-review** @ fae252a — ✅ 1 resolved · 🔁 1 not reproduced (code unchanged) · ❌ 0 still open · 🆕 0 new → LGTM\n<!-- needlefish-round -->";
const OWN_ERROR_COMMENT =
  "⚠️ **Needlefish review FAILED TO RUN** — this red check is an infra failure, not a code verdict.\n\n```\nspawn codex ETIMEDOUT\n```\n\nRe-trigger: push a new commit or re-run with --recheck.\n<!-- needlefish-error -->";
const OWN_REVIEW_BODY =
  'LGTM ✅ — Adds a `needlefish doctor` setup-diagnostic command.\n\nCoverage: 18/18 changed files deep-reviewed across 4 hotspots\n\n## Findings\n\n<sub>6 calls · total 15m 13s</sub>\n\n<!-- needlefish-state: {"v":1,"headSha":"691005cd691922be6916b3dfa33b344480f5b8a6","findings":[{"file":"src/adapters/doctor.ts","lineStart":150,"category":"validation","title":"doctor runner check passes"}]} -->\n';
const OWN_INLINE_FINDING_UNMARKED =
  "**P2** Doctor base check fails (exit 1) on a dirty worktree that needs no base ref\n\nbaseCheck only skips the base-ref precondition for `headExists === false`.\n\n**Fix:** Make the base check mirror the review's mode selection.\n\n**Validate:** Add a doctor.test.ts case.";
const OWN_INLINE_FINDING_MARKED = `${OWN_INLINE_FINDING_UNMARKED}\n\n<!-- needlefish-finding -->`;
const OWN_EXPLAIN_UNMARKED =
  "## 🔍 Needlefish explain\n\nThe guard runs after the write.\n\n<sub>Explanation only — the review verdict is unchanged.</sub>";
const OWN_EXPLAIN_MARKED = `${OWN_EXPLAIN_UNMARKED}\n<!-- needlefish-explain -->`;

const HUMAN_QUOTE_REPLY = `${OWN_ROUND_COMMENT.split("\n")
  .map((line) => `> ${line}`)
  .join("\n")}\n\nThe resolved one was intentional, see the design note.`;
const HUMAN_THREAD_REPLY = "We keep this behavior on purpose; the caller validates upstream.";
const HUMAN_SEVERITY_STYLE = "**P2** I think this is actually a real bug, not a nit.";
const HUMAN_MENTIONS_MARKER =
  "The round comment ends in `<!-- needlefish-round -->` so later rounds can find it.";
const HUMAN_LANE_NOTE =
  "Lane qualification: eval/results/2026-09-20-codex-cpa-deepseek41-flash-high-x1.json — 87 fixtures.";

// GitHub asserts the poster is a bot; not this run's identity (local mode, another setup).
const BOT = { bot: true, own: false };
// github-actions[bot] posting from this run.
const OWN_BOT = { bot: true, own: true };
const HUMAN = { bot: false, own: false };
// A maintainer whose PAT the runner also posts with.
const OWN_HUMAN = { bot: false, own: true };
const HUMAN_PASTED_MARKER_LAST = `Pasting the raw round comment for reference:\n\n${OWN_ROUND_COMMENT}`;
const HUMAN_PASTED_MARKER_MID = `${OWN_ROUND_COMMENT}\n\nI disagree with the resolved count.`;
const HUMAN_FENCED_MARKER = "The marker looks like this:\n\n```html\n<!-- needlefish-round -->\n```";
const HUMAN_FENCED_STATE = `See the state marker:\n\n\`\`\`\n${OWN_REVIEW_BODY.trim().split("\n").pop()}\n\`\`\``;

test("isNeedlefishPost recognizes every kind of Needlefish post by its final marker line", () => {
  for (const body of [
    OWN_ROUND_COMMENT,
    OWN_ERROR_COMMENT,
    OWN_REVIEW_BODY,
    OWN_INLINE_FINDING_MARKED,
    OWN_EXPLAIN_MARKED,
  ]) {
    for (const author of [BOT, OWN_BOT, OWN_HUMAN]) {
      assert.equal(isNeedlefishPost(body, author), true, body.slice(0, 40));
    }
    assert.equal(isNeedlefishPost(body.trim(), BOT), true, body.slice(0, 40));
    assert.equal(isNeedlefishPost(body, HUMAN), false, "no authorship signal keeps the body");
  }
});

const OWN_INLINE_FINDING_OLDEST =
  "**P2 (validation): Reject malformed model output before deriving a verdict**\n\nThe parser accepts any object.\n\n_Suggested fix:_ Make the model-output boundary strict.";

const OWN_REVIEW_BODY_OLDEST =
  "# Needlefish PR Review\n\n**Verdict:** PASS\n\n- Ran `pnpm check`; TypeScript completed without errors.";

test("isNeedlefishPost recognizes pre-marker posts only from this run's bot identity", () => {
  for (const body of [
    OWN_INLINE_FINDING_UNMARKED,
    OWN_INLINE_FINDING_OLDEST,
    OWN_EXPLAIN_UNMARKED,
    OWN_REVIEW_BODY_OLDEST,
  ]) {
    assert.equal(isNeedlefishPost(body, OWN_BOT), true, body.slice(0, 40));
    assert.equal(isNeedlefishPost(body, BOT), false, body.slice(0, 40));
    assert.equal(isNeedlefishPost(body, OWN_HUMAN), false, "a maintainer on the runner's PAT is not a bot");
    assert.equal(isNeedlefishPost(body, HUMAN), false, body.slice(0, 40));
  }
});

test("isNeedlefishPost never drops a human comment", () => {
  const humanBodies = [
    HUMAN_QUOTE_REPLY,
    HUMAN_THREAD_REPLY,
    HUMAN_SEVERITY_STYLE,
    HUMAN_MENTIONS_MARKER,
    HUMAN_LANE_NOTE,
    HUMAN_PASTED_MARKER_LAST,
    HUMAN_PASTED_MARKER_MID,
    HUMAN_FENCED_MARKER,
    HUMAN_FENCED_STATE,
    OWN_EXPLAIN_UNMARKED,
    "LGTM from me, one nit inline.",
    "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.",
  ];
  for (const body of humanBodies) {
    assert.equal(isNeedlefishPost(body, HUMAN), false, body.slice(0, 40));
  }
  // Under the runner's PAT identity only a body whose final line is a raw
  // marker counts as Needlefish's; everything else a maintainer writes stays.
  for (const body of [
    HUMAN_QUOTE_REPLY,
    HUMAN_THREAD_REPLY,
    HUMAN_SEVERITY_STYLE,
    HUMAN_MENTIONS_MARKER,
    HUMAN_PASTED_MARKER_MID,
    HUMAN_FENCED_MARKER,
    HUMAN_FENCED_STATE,
  ]) {
    assert.equal(isNeedlefishPost(body, OWN_HUMAN), false, body.slice(0, 40));
  }
  // A bot-typed post with a marker only mid-body is not one of ours either.
  assert.equal(isNeedlefishPost(HUMAN_PASTED_MARKER_MID, OWN_BOT), false);
});

test("normalizeBodyList reads REST authorship and drops only Needlefish's own posts, in order", () => {
  const own = { login: "github-actions[bot]", type: "Bot" };
  const otherBot = { login: "copilot-pull-request-reviewer[bot]", type: "Bot" };
  const human = { login: "frankekn", type: "User" };
  const bodies = normalizeBodyList(
    [
      { user: own, body: OWN_ROUND_COMMENT },
      { user: human, body: HUMAN_QUOTE_REPLY },
      { user: own, body: OWN_ERROR_COMMENT },
      { user: own, body: OWN_INLINE_FINDING_UNMARKED },
      { user: human, body: HUMAN_THREAD_REPLY },
      { user: human, body: HUMAN_SEVERITY_STYLE },
      { user: human, body: HUMAN_PASTED_MARKER_LAST },
      { user: otherBot, body: OWN_INLINE_FINDING_UNMARKED },
      { user: own, body: "" },
      " plain string comment ",
    ],
    (item) => (item.user as { login: string }).login === own.login
  );
  assert.deepEqual(bodies, [
    HUMAN_QUOTE_REPLY,
    HUMAN_THREAD_REPLY,
    HUMAN_SEVERITY_STYLE,
    HUMAN_PASTED_MARKER_LAST,
    OWN_INLINE_FINDING_UNMARKED,
    "plain string comment",
  ]);
});

test("normalizePrMeta reads gh authorship and drops Needlefish's own review bodies and comments", () => {
  const meta = normalizePrMeta({
    number: 200,
    title: "doctor",
    comments: [
      { author: { login: "github-actions" }, body: OWN_ROUND_COMMENT },
      { author: { login: "frankekn" }, body: HUMAN_LANE_NOTE },
      { author: { login: "frankekn" }, body: HUMAN_PASTED_MARKER_LAST },
      { author: { login: "github-actions" }, body: OWN_EXPLAIN_UNMARKED },
    ],
    reviews: [
      { author: { login: "github-actions" }, body: OWN_REVIEW_BODY },
      { author: { login: "github-actions" }, body: "" },
      { author: { login: "frankekn" }, body: "LGTM from me, one nit inline." },
      { author: { login: "chatgpt-codex-connector" }, body: "### 💡 Codex Review" },
    ],
  });
  assert.deepEqual(meta.comments, [HUMAN_LANE_NOTE, HUMAN_PASTED_MARKER_LAST, OWN_EXPLAIN_UNMARKED]);
  assert.deepEqual(meta.reviews, ["LGTM from me, one nit inline.", "### 💡 Codex Review"]);
});

test("normalizePrMeta uses fallback number when number is missing", () => {
  const meta = normalizePrMeta({ title: "Fix parser" }, 12);

  assert.equal(meta.number, 12);
});

test("normalizePrMeta rejects missing number without fallback", () => {
  assert.throws(() => normalizePrMeta({ title: "Fix parser" }), /invalid number/);
});

test("normalizePrMeta rejects nonpositive or non-integer numbers", () => {
  for (const number of [0, -1, 1.5]) {
    assert.throws(() => normalizePrMeta({ number }), /invalid number/);
  }
});

test("normalizePrMeta drops non-object status checks", () => {
  const meta = normalizePrMeta({
    number: 12,
    statusCheckRollup: [
      "bad",
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
  });

  assert.deepEqual(meta.checks, [
    { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
  ]);
});

test("normalizePrMeta turns non-string body into null", () => {
  for (const body of [null, 123]) {
    const meta = normalizePrMeta({ number: 12, body });

    assert.equal(meta.body, null);
  }
});

test("normalizePrMeta normalizes comments and reviews with bodyList behavior", () => {
  const meta = normalizePrMeta({
    number: 12,
    comments: [" first "],
    reviews: [{ body: " second " }],
  });

  assert.deepEqual(meta.comments, ["first"]);
  assert.deepEqual(meta.reviews, ["second"]);
});

test("normalizeBodyList trims strings and filters empty entries", () => {
  const bodies = normalizeBodyList([" first ", "", " ", "second"]);

  assert.deepEqual(bodies, ["first", "second"]);
});

test("normalizeBodyList accepts body-shaped objects", () => {
  const bodies = normalizeBodyList([{ body: " first " }, { body: " second " }]);

  assert.deepEqual(bodies, ["first", "second"]);
});

test("normalizeBodyList handles mixed string and body-shaped entries", () => {
  const bodies = normalizeBodyList([" first ", { body: " second " }, { body: "" }]);

  assert.deepEqual(bodies, ["first", "second"]);
});

test("normalizeBodyList returns empty array for non-array input", () => {
  for (const raw of [null, "string", {}]) {
    assert.deepEqual(normalizeBodyList(raw), []);
  }
});

test("normalizeFinding accepts a complete model finding", () => {
  const raw = {
    severity: "p2",
    title: "Rejects valid input",
    category: "validation",
    file: "src/app.ts",
    lineStart: 7,
    confidence: 0.8,
    whyItBreaks: "Valid input is rejected.",
    suggestedFix: "Accept the valid input.",
  };

  const finding = normalizeFinding(raw);

  assert.equal(finding.severity, "P2");
  assert.equal(finding.lineEnd, 7);
  assert.equal(finding.confidence, 0.8);
});

test("normalizeFinding keeps a valid replacement", () => {
  const raw = {
    severity: "P2",
    title: "Wrong branch",
    category: "bug",
    file: "src/app.ts",
    lineStart: 3,
    lineEnd: 4,
    confidence: 0.9,
    whyItBreaks: "The branch returns the wrong value.",
    suggestedFix: "Replace the branch.",
    replacement: { lines: ["  return ok;", "}"] },
  };

  const finding = normalizeFinding(raw);

  assert.deepEqual(finding.replacement, { lines: ["  return ok;", "}"] });
});

test("normalizeFinding drops malformed replacement but keeps finding", () => {
  const base = {
    severity: "P2",
    title: "Wrong branch",
    category: "bug",
    file: "src/app.ts",
    lineStart: 3,
    confidence: 0.9,
    whyItBreaks: "The branch returns the wrong value.",
    suggestedFix: "Replace the branch.",
  };

  for (const replacement of [
    { lines: "return ok;" },
    { lines: ["return ok;", 1] },
    { lines: [] },
  ]) {
    const finding = normalizeFinding({ ...base, replacement });

    assert.equal(finding.title, "Wrong branch");
    assert.equal(finding.replacement, undefined);
  }
});

test("normalizeFinding drops multiline replacement elements but keeps finding", () => {
  const raw = {
    severity: "P2",
    title: "Wrong branch",
    category: "bug",
    file: "src/app.ts",
    lineStart: 3,
    confidence: 0.9,
    whyItBreaks: "The branch returns the wrong value.",
    suggestedFix: "Replace the branch.",
    replacement: { lines: ["return ok;\nreturn wrong;"] },
  };

  const finding = normalizeFinding(raw);

  assert.equal(finding.title, "Wrong branch");
  assert.equal(finding.replacement, undefined);
});

test("normalizeReview keeps old JSON output unchanged without replacement", () => {
  const raw = {
    summary: "reviewed",
    findings: [
      {
        severity: "P3",
        title: "Small issue",
        category: "bug",
        file: "src/app.ts",
        lineStart: 1,
        whyItBreaks: "It breaks.",
        suggestedFix: "Fix it.",
      },
    ],
    checked: ["diff"],
    residual_risks: [],
  };

  const review = normalizeReview(raw);

  assert.equal(JSON.stringify(review), JSON.stringify({
    summary: "reviewed",
    findings: [
      {
        severity: "P3",
        category: "bug",
        file: "src/app.ts",
        title: "Small issue",
        whyItBreaks: "It breaks.",
        suggestedFix: "Fix it.",
        lineStart: 1,
        lineEnd: 1,
        confidence: 0,
        validation: "",
      },
    ],
    checked: ["diff"],
    residual_risks: [],
  }));
});

test("normalizeFinding rejects line ranges that run backward", () => {
  const raw = {
    severity: "P3",
    title: "Bad range",
    category: "bug",
    file: "src/app.ts",
    lineStart: 7,
    lineEnd: 6,
    whyItBreaks: "The cited range is invalid.",
    suggestedFix: "Fix the range.",
  };

  assert.throws(() => normalizeFinding(raw), /lineEnd before lineStart/);
});

test("normalizeFinding rejects low-confidence blocking findings", () => {
  const raw = {
    severity: "P2",
    title: "Weak blocker",
    category: "bug",
    file: "src/app.ts",
    lineStart: 1,
    confidence: 0.5,
    whyItBreaks: "Maybe breaks.",
    suggestedFix: "Maybe fix.",
  };

  assert.throws(() => normalizeFinding(raw), /blocking finding has low confidence/);
});

test("normalizeFinding rejects blocking confidence below prompt contract", () => {
  const raw = {
    severity: "P2",
    title: "Below contract blocker",
    category: "bug",
    file: "src/app.ts",
    lineStart: 1,
    confidence: 0.69,
    whyItBreaks: "Below-contract confidence should not block a PR.",
    suggestedFix: "Reject weak blocking confidence.",
  };

  assert.throws(() => normalizeFinding(raw), /blocking finding has low confidence/);
});

test("normalizeFinding rejects nonnumeric blocking confidence", () => {
  const raw = {
    severity: "P2",
    title: "Malformed blocker",
    category: "bug",
    file: "src/app.ts",
    lineStart: 1,
    confidence: "bad",
    whyItBreaks: "Invalid model output should not block a PR.",
    suggestedFix: "Reject malformed confidence.",
  };

  assert.throws(() => normalizeFinding(raw), /invalid confidence/);
});

test("normalizeReview rejects empty residual risk text", () => {
  const raw = {
    summary: "reviewed",
    findings: [],
    checked: ["diff"],
    residual_risks: [{ text: "", blocks: true }],
  };

  assert.throws(() => normalizeReview(raw), /residual risk text missing/);
  assert.throws(() => normalizeReview(raw, true), /malformed review output: residual risk text missing/);
  assert.throws(() => normalizeReview(raw, false), /malformed review output: residual risk text missing/);
});

function rawReview(residual_risks: unknown): Record<string, unknown> {
  return {
    summary: "s",
    findings: [],
    checked: ["x"],
    residual_risks,
  };
}

const NON_OBJECT_RESIDUAL_ENTRIES: readonly { readonly kind: string; readonly value: unknown }[] = [
  { kind: "string", value: "could not verify the changed path" },
  { kind: "number", value: 0 },
  { kind: "null", value: null },
  { kind: "boolean", value: false },
  { kind: "array", value: [{ text: "nested residual", blocks: true }] },
];

for (const { kind, value } of NON_OBJECT_RESIDUAL_ENTRIES) {
  test(`normalizeReview rejects ${kind} residual risk entry in both strict modes`, () => {
    const raw = rawReview([value]);
    const expected = /malformed review output: residual risk not an object/;
    assert.throws(() => normalizeReview(raw), expected);
    assert.throws(() => normalizeReview(raw, true), expected);
    assert.throws(() => normalizeReview(raw, false), expected);
  });
}

test("normalizeReview rejects boolean true residual risk entry in both strict modes", () => {
  const raw = rawReview([true]);
  const expected = /malformed review output: residual risk not an object/;
  assert.throws(() => normalizeReview(raw), expected);
  assert.throws(() => normalizeReview(raw, true), expected);
  assert.throws(() => normalizeReview(raw, false), expected);
});

test("normalizeReview rejects mixed valid residual object and bare string in both strict modes", () => {
  const raw = rawReview([
    { text: "local helper untraced", blocks: false },
    "could not verify the changed path",
  ]);
  const expected = /malformed review output: residual risk not an object/;
  assert.throws(() => normalizeReview(raw), expected);
  assert.throws(() => normalizeReview(raw, true), expected);
  assert.throws(() => normalizeReview(raw, false), expected);
});

test("normalizeReview round-trips blocking residual risk to needs_human in both strict modes", () => {
  const residual = { text: "could not verify the changed path", blocks: true };
  for (const strict of [true, false] as const) {
    const review = normalizeReview(rawReview([residual]), strict);
    assert.deepEqual(review.residual_risks, [residual]);
    assert.equal(deriveVerdict(review.findings, review.residual_risks), "needs_human");
  }
  const defaultReview = normalizeReview(rawReview([residual]));
  assert.deepEqual(defaultReview.residual_risks, [residual]);
  assert.equal(deriveVerdict(defaultReview.findings, defaultReview.residual_risks), "needs_human");
});

test("normalizeReview round-trips non-blocking residual risk to pass in both strict modes", () => {
  const residual = { text: "low confidence private helper", blocks: false };
  for (const strict of [true, false] as const) {
    const review = normalizeReview(rawReview([residual]), strict);
    assert.deepEqual(review.residual_risks, [residual]);
    assert.equal(deriveVerdict(review.findings, review.residual_risks), "pass");
  }
  const defaultReview = normalizeReview(rawReview([residual]));
  assert.deepEqual(defaultReview.residual_risks, [residual]);
  assert.equal(deriveVerdict(defaultReview.findings, defaultReview.residual_risks), "pass");
});

test("normalizeReview accepts empty residual_risks in both strict modes", () => {
  for (const strict of [true, false] as const) {
    const review = normalizeReview(rawReview([]), strict);
    assert.deepEqual(review.residual_risks, []);
    assert.equal(deriveVerdict(review.findings, review.residual_risks), "pass");
  }
  const defaultReview = normalizeReview(rawReview([]));
  assert.deepEqual(defaultReview.residual_risks, []);
  assert.equal(deriveVerdict(defaultReview.findings, defaultReview.residual_risks), "pass");
});

test("normalizeReview loose mode still rejects malformed residuals after dropping malformed findings", () => {
  const raw = {
    summary: "s",
    findings: [{ severity: "bad" }],
    checked: ["x"],
    residual_risks: ["could not verify the changed path"],
  };

  assert.throws(
    () => normalizeReview(raw, false),
    /malformed review output: residual risk not an object/,
  );
});

test("normalizeReview drops malformed findings in loose mode", () => {
  const raw = {
    summary: "reviewed",
    findings: [
      {
        severity: "P3",
        title: "Small issue",
        category: "bug",
        file: "src/app.ts",
        lineStart: 1,
        whyItBreaks: "It breaks.",
        suggestedFix: "Fix it.",
      },
      { severity: "bad" },
    ],
    checked: ["diff"],
    residual_risks: [{ text: "none", blocks: false }],
  };

  const review = normalizeReview(raw, false);

  assert.equal(review.findings.length, 1);
  assert.deepEqual(review.checked, ["diff"]);
});
