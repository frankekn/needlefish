## Section A — implementation review

Overall, the recent structure is the **right size for v0.1**. The split into `cli/args`, `adapters/local|github`, `core/review`, and small `shared/*` helpers is appropriate; it avoids a broad framework while making the main seams visible: CLI parsing, repo/process access, Codex invocation, model-output normalization, verdict derivation, and rendering. The strongest part is that verdicts are deterministic and outside model control: `deriveVerdict` gates only on P0–P2 findings or blocking residual risks, then otherwise passes. 

### P0 — tighten before trusting Action mode as a merge gate

**P0. GitHub mode needs a stronger “reviewed exactly this PR head/base” invariant.**
`runGithub` fetches the PR object, but then falls back to `PR_HEAD_SHA || git rev-parse HEAD` and `PR_BASE_SHA || merge-base origin/main HEAD`, followed by another merge-base calculation. It also calls `changedFiles(cwd, mergeBase)` without passing `headSha`, so changed-file metadata can silently use `HEAD` even when the patch uses a different head SHA.   This matters because the README positions GitHub mode as posting a review plus a check-run that can gate merge decisions. 

Small fix: derive `baseSha` and `headSha` from the PR API response first, assert they match the checked-out commit or fetch them explicitly, and pass `headSha` into `changedFiles`.

```ts
const base = isRecord(pr.base) ? stringField(pr.base, "sha") : "";
const head = isRecord(pr.head) ? stringField(pr.head, "sha") : "";

const headSha = process.env.PR_HEAD_SHA || head || git(["rev-parse", "HEAD"], cwd);
const baseSha = process.env.PR_BASE_SHA || base;
if (!baseSha || !headSha) throw new Error("Could not resolve PR base/head SHA");

const mergeBase = git(["merge-base", baseSha, headSha], cwd);
const changed = changedFiles(cwd, mergeBase, headSha);
```

Also fail loudly when `git diff mergeBase headSha` is empty in GitHub mode unless the PR truly has no diff.

**P0. The read-only identity is good, but not complete if the runner has persisted GitHub auth.**
`runCodex` deletes `GH_TOKEN`, `GITHUB_TOKEN`, and `GITHUB_API_TOKEN` before spawning Codex, which is the right direction.  But a self-hosted runner can also have persisted `gh` credentials, and the prompts explicitly allow read-only shell inspection.  The README also warns that Codex may auto-load global instructions on the runner. 

Small fix: when spawning Codex, set `GH_CONFIG_DIR` to an empty temp directory owned by the Codex run, in addition to deleting token env vars. That preserves the read-only design without changing product identity.

```ts
const ghConfigDir = path.join(tmp, "gh-empty");
mkdirSync(ghConfigDir, { recursive: true });

const env = { ...process.env, GH_CONFIG_DIR: ghConfigDir };
delete env.GH_TOKEN;
delete env.GITHUB_TOKEN;
delete env.GITHUB_API_TOKEN;
```

### P1 — correctness and maintainability issues worth fixing next

**P1. `--deep` is currently more promise than behavior.**
The CLI parses `--deep` into `LocalOptions`.  The bundle carries `deep`, and the README describes it as “wider context.”  But the small-review prompt does not make `deep` operational, and the large-review prompt includes the field only indirectly through the map bundle.  

Small fix: make `--deep` explicitly choose the large/map/deep path, or add a short `Deep mode: {{DEEP}}` clause to `review.md` that requires 2-layer call-site tracing and test/history inspection. I would prefer the first option:

```ts
export async function review(bundle: Bundle): Promise<ReviewResult> {
  return bundle.deep || isLarge(bundle) ? reviewLarge(bundle) : reviewSmall(bundle);
}
```

Then update README wording to say deep mode uses the map/deep pipeline even for smaller diffs.

**P1. Local mode ignores dirty worktree changes.**
Local review compares `merge-base..HEAD`.  That is fine for branch PR review, but many CLI users will expect “current worktree” to include staged or unstaged changes. This is a correctness-of-review expectation issue, not a style nit.

Small fix: detect dirty state and either fail with a clear message or add `--worktree` later. For now, fail or warn:

```ts
const dirty = git(["status", "--porcelain"], cwd);
if (dirty.trim()) {
  process.stderr.write(
    "needlefish: warning: uncommitted changes are not included; review is merge-base..HEAD only.\n"
  );
}
```

**P1. GitHub inline comments are optimistic about line anchoring.**
Inline comments are posted when the finding’s file is changed and `lineStart > 0`.  GitHub review comments require the line to be valid on the PR diff’s RIGHT side. A model can cite a context line, deleted line, or stale line; then the batch review can fail and Needlefish falls back to a body-only review.  The fallback is good, but it can silently degrade the feature.

Small fix: parse the diff hunks into a set of added/right-side line numbers per file and only inline-comment on those. Keep all findings in the body regardless.

**P1. Large-diff coverage backstop can become one oversized “tail” hotspot.**
The large path selects up to six hotspots, then adds all uncovered files into one low-risk tail hotspot.  That prevents silent skipping, which is good, but it can create exactly the kind of oversized surface that the map/deep design was meant to avoid.

Small fix: split tail files by `surface` and chunk by a small count, for example 4–6 files per tail hotspot. This keeps the current design but makes deep passes more reliable.

**P1. Model-output validation is partly too strict and partly too loose.**
Strict `normalizeReview` rejects the whole review if one model finding is malformed.  That is sensible for keeping the output clean, but risky for availability. At the same time, individual finding validation allows `lineEnd < lineStart`, default confidence `0`, arbitrary residual text, and map hotspots with files not constrained to changed files.  

Small fix: keep strict mode, but validate the invariants Needlefish actually depends on:

```ts
if (lineEnd < lineStart) {
  throw new Error(`malformed finding: lineEnd before lineStart`);
}
if (severity !== "P3" && Number(record.confidence ?? 0) < 0.65) {
  throw new Error("malformed finding: blocking finding has low confidence");
}
```

For map output, filter or reject hotspot files that are not in `bundle.changedFiles`, while preserving external consumers only in `edges`.

**P1. CLI accepts local-only flags in GitHub mode and then drops them.**
`--base`, `--focus`, and `--deep` are parsed into `opts`, but the GitHub command return shape only carries `pr`, `repo`, `fix`, and `recheck`.  That makes `needlefish --github --pr 123 --base develop` look accepted while doing nothing.

Small fix: either support them in GitHub mode or reject them when `--github` is set. Given the “small diffs” constraint, reject first.

**P1. Prompt contracts and TypeScript schema are close, but not aligned enough.**
The schema already supports `consumerFile` and `consumerLine`.  The deep prompt says cross-file claims must cite both changed and consuming locations, but the JSON output shape does not expose those fields.   This forces evidence into prose, which is harder to validate.

Small fix: add optional `consumerFile` and `consumerLine` to prompt examples and teach the critic to require them for cross-file findings.

### P2 — polish and simplification

**P2. `process.ts` should report spawn errors and support timeout.**
`runText` checks `res.status !== 0` but does not explicitly check `res.error`.  Missing `git`/`gh` or an auth prompt will produce less useful diagnostics than necessary.

Small fix:

```ts
if (res.error) throw res.error;
if (res.status !== 0) {
  throw new Error(`${command} ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
}
```

Also add optional timeout for `gh` calls.

**P2. `Bundle.agentsMd` should not be nullable.**
`Bundle.agentsMd` is typed as `string | null`, but `makeBundle` always calls `readAgents` and returns a string, including the explicit no-AGENTS sentinel.   Tighten it to `readonly agentsMd: string`.

**P2. Version is duplicated.**
The CLI prints `needlefish 0.1.0`, while `package.json` also defines `0.1.0`.   This is fine for v0.1, but it will drift. A tiny generated constant or reading package metadata would fix it.

**P2. `runJson` is unused or underused.**
`shared/process.ts` exports `runJson`, but GitHub mode defines its own `ghJson`.   Either reuse `runJson` through a `ghJson` wrapper or delete `runJson` until needed.

**P2. README is good but ahead of implementation in a few places.**
The README is clear about local use, GitHub mode, read-only identity, and verdict mapping.  It should add a short “Current limitations” block: reviews committed diff only, `--deep` semantics, inline comments may fall back to body-only, and self-hosted runner credential isolation.

---

## Section B — project improvement roadmap

### Do now

1. **Lock down Action diff identity.** Use PR API base/head SHA, pass `headSha` through `changedFiles`, and fail if the checked-out repo cannot produce the expected diff.

2. **Harden read-only Codex execution.** Keep deleting GitHub token env vars, but also set `GH_CONFIG_DIR` to an empty temp directory for the Codex subprocess. This preserves the stated read-only behavior. 

3. **Make `--deep` real or remove its promise.** Best small change: `bundle.deep || isLarge(bundle)` selects the map/deep path.

4. **Reject ignored CLI combinations.** In GitHub mode, either reject `--base`, `--focus`, and `--deep`, or carry them through intentionally. Reject empty `--repo=`, `--base=`, and `--focus=`.

5. **Add low-cost invariants to normalization.** Validate `lineEnd >= lineStart`, non-empty residual-risk text, confidence floor for blocking findings, and map files constrained to changed files.

6. **Add tests for the above.** The current tests cover parser basics, verdicts, classification, JSON extraction, and normalization loose mode.    Expand this before changing orchestration.

### Next

1. **Introduce a tiny review dependency seam.** Do not rewrite the architecture. Add an optional `deps` argument to `review` so tests can inject fake Codex output instead of spawning real Codex.

```ts
interface ReviewDeps {
  runCodex(prompt: string, opts: CodexOptions): string;
  loadPrompt(name: string): string;
}
```

Default it to current behavior. This unlocks deterministic orchestration tests.

2. **Test GitHub mode with fake `gh` and fake `git`.** Capture review/check payloads and verify:

   * failure posts a failed check;
   * `pass` posts `COMMENT`, not `APPROVE`;
   * invalid inline comments fall back to body-only;
   * changed paths and line anchors are computed against the PR head.

3. **Improve large-diff tail handling.** Split uncovered files by surface and chunk size instead of one tail hotspot.

4. **Add observability without dependencies.** Save a small local trace beside `last-review.json`: prompt kind, patch size, changed-file count, Codex duration, retry count, map hotspot count, number of findings before/after critic. Keep prompts themselves out of logs unless an explicit debug env var is set.

5. **Improve check-run evidence.** The GitHub check output currently puts rendered Markdown into the summary.  Add concise counts and maybe check annotations later, but first make the summary machine-readable enough for troubleshooting.

6. **Docs: add threat model and limitations.** Keep README short, but add a page or section for:

   * what read-only means and does not mean;
   * self-hosted runner isolation;
   * what diff range is reviewed;
   * how `--deep` behaves;
   * how verdicts are derived.

### Later

1. **Package as a real distributable CLI.** The current shim runs repo-local `tsx` from `node_modules`.  That is fine for a private v0.1 repo, but awkward for installation. Later, add a `build` that emits `dist/cli.js`, copy `prompts/`, and point `bin.needlefish` at compiled JS.

2. **Reusable `action.yml`.** This is already listed as future work.  Do it after Action mode has stronger tests.

3. **Config file.** A `.needlefish.json` or `.needlefishrc` can eventually hold base ref, severity gate, default focus, and prompt mode. This is also already in the future list. 

4. **Optional second recall sweep.** The TODO notes that over-block detection can miss some cases on a single draw.  Add this only after you have an eval harness, otherwise it may increase false positives.

### Skip for now

1. **No schema-validation dependency yet.** `normalize.ts` is small and readable. A dependency like Zod would only be justified if the schema grows materially.

2. **No broad plugin framework.** The current file split is enough.

3. **No mutating `--fix` lane until review quality is measured.** The README and TODO correctly keep v0.1 read-only. 

4. **No formal PR approvals from the bot.** The README’s current `pass → COMMENT + success check` behavior is safer and consistent with the anti-self-approval note. 

---

## Section C — prompt improvements

The prompt set is unusually disciplined already: it prefers zero findings, requires changed-line anchoring, has an adversarial critic, and explicitly handles two known recall traps.  The main issue is that the prompts are now **heavier than the output contract**. They ask for trigger enumerations and cross-file evidence, but the JSON schema does not give the model structured places to put all of that evidence.

### `prompts/review.md`

**Problem 1: field-name mismatch.**
The prompt says “read changed_files,” but the bundle field is `changedFiles`.  

Concrete edit:

```diff
- 1. Surface map: read changed_files with surface labels.
+ 1. Surface map: read changedFiles with surface labels.
```

**Problem 2: trigger output is required, but no output slot exists.**
The prompt says a triggered section left blank or absent should block the verdict.  But the JSON shape only has `summary`, `findings`, `checked`, and `residual_risks`.  Put trigger evidence into `checked` with a required prefix.

Add this after the trigger section:

```md
# Evidence recording contract
Use `checked[]` for proof, not vague activity logs.

For every P0/P1/P2 finding, include one checked entry beginning with:
- `EVIDENCE finding:<title> changed=<file:line> effect=<specific wrong behavior>`

For every cleared Trigger A, include:
- `TRIGGER_A cleared predicate=<symbol> callsites=[file:line action governs=yes/no ...]`

For every cleared Trigger B, include:
- `TRIGGER_B cleared loop=<file:line> timeout=<file:line value> per_iteration=<file:line value> max_iterations=<file:line value> product=<value> persisted_before_failure=yes/no`

If a trigger fires but cannot be cleared, do not invent a finding. Add one `residual_risks[]` entry with `blocks:true` and name the missing evidence.
```

**Problem 3: cross-file schema should use existing fields.**
The TypeScript schema already supports `consumerFile` and `consumerLine`.  Add these optional fields to the output example:

```diff
        "validation": "command or step to prove the fix"
+       ,"consumerFile": "repo-relative path of downstream guard, if cross-file",
+       "consumerLine": 1
```

Better formatted replacement for the finding object:

```json
{
  "severity": "P0|P1|P2|P3",
  "title": "imperative, <=80 chars",
  "category": "bug|contract|duplicate|runtime|security|validation",
  "file": "changed file from this diff",
  "lineStart": 1,
  "lineEnd": 1,
  "confidence": 0.0,
  "whyItBreaks": "At HEAD, changed X causes Y at consumer file:line, producing Z.",
  "suggestedFix": "minimal fix",
  "validation": "command or step to prove the fix",
  "consumerFile": "optional repo-relative consumer path for cross-file claims",
  "consumerLine": 1
}
```

**Problem 4: reduce false positives from residual risks.**
The sentinel-value rule can over-block if applied to every default-ish value.  Keep the recall behavior, but make materiality explicit:

```md
Set `residual_risks.blocks=true` for unresolved sentinel/default tracing only when the value feeds externally visible behavior, persistence, authorization, routing, validation, or a public contract. Do not block solely because a local/private helper value was not exhaustively traced.
```

**Problem 5: confidence has no meaning.**
Add:

```md
Confidence is evidence confidence, not gut feel:
- 0.90–1.00: changed line and failing consumer/path verified directly.
- 0.70–0.89: changed line verified and failure path strongly established.
- Below 0.70: do not emit P0/P1/P2; use P3 or residual risk.
```

### `prompts/map.md`

`map.md` has the right job: no bug review, compute blast radius, group surfaces.  The main improvement is to make its output easier for core code to trust.

Replace the “Rules” block with:

```md
Rules:
- Every repo-relative changed file in `changedFiles` must appear in exactly one hotspot unless a file is genuinely cross-cutting; if duplicated, explain why in `why`.
- `files` must contain changed files only. Put non-changed consumers only in `edges`.
- Always include `edges`; use `edges: []` when there are no real consumers.
- Each edge must come from an actual search or direct import/call/reference inspection. Do not infer edges from names or folders.
- `consumerLine` must be a positive HEAD line number when known; use 0 only when the consumer file is known but the line is genuinely unresolved.
- Keep hotspots to <=6 total; each hotspot should be reviewable in one deep pass. Merge tiny related changes, but do not create a giant catch-all unless the PR is genuinely one surface.
- If `focus` is set, rank matching surfaces higher, but do not omit other changed files.
```

Add this to improve large diff handling:

```md
Risk ranking guidance:
High risk = auth, money/data persistence, migrations, public API/CLI contracts, workflow permissions/secrets, dependency execution, or changed predicates used by multiple consumers.
Medium risk = behavior changes with bounded blast radius.
Low risk = docs/tests/internal refactors with no changed runtime path.
```

### `prompts/deep.md`

`deep.md` is strong but dense. It duplicates much of `review.md`, which is acceptable for v0.1 because prompt files are the product logic. The most important improvement is the same structured evidence contract. 

Add after “Hard rules”:

```md
# Evidence recording contract
A deep pass is not complete until `checked[]` records:
- `FILES inspected=[...]`
- for each hotspot edge: `EDGE producer=<symbol> consumer=<file:line> outcome=<passes|rejects|not-applicable> effect=<behavior>`
- for Trigger A if fired: `TRIGGER_A ...`
- for Trigger B if fired: `TRIGGER_B ...`

Do not use generic checked entries like "reviewed diff" or "looked at tests".
```

Add optional consumer fields to the output example, same as `review.md`.

Tighten the outside-surface rule:

```diff
- Do not chase files outside this surface unless tracing an edge's consumer.
+ Do not chase files outside this surface except to verify a concrete consumer/call-site/timeout needed by an edge, Trigger A, Trigger B, or a changed public contract. Stop after the evidence needed to keep or drop the finding.
```

This keeps recall for real cross-file defects without turning a deep pass into whole-repo archaeology.

### `prompts/critic.md`

The critic is the right idea: prune, downgrade, and never pad.  It should become the enforcer of structured evidence.

Replace the rules block with this tighter version:

```md
# Rules
- Your primary job is to DELETE weak findings. Never add new findings.
- DELETE a finding if it is style/naming-only, speculative, not introduced by this diff, not tied to a changed line, not behavior/security/data/compatibility-affecting, missing a plausible minimal fix, or duplicate.
- DELETE cross-file findings unless they identify both:
  1. the changed line in `file:lineStart-lineEnd`, and
  2. the downstream consumer as `consumerFile:consumerLine` or an equivalent explicit citation in `whyItBreaks`.
- For every kept finding, re-open the changed hunk with `git diff <base>..<head> -- <file>`.
- For every kept cross-file finding, re-open the consumer at HEAD with `git show HEAD:<consumerFile>` or `rg`.
- Correct severity downward when inflated. Upgrade only when the evidence is direct and the current severity would understate a real blocking defect.
- Keep `residual_risks.blocks=true` only when the missing evidence genuinely prevents a verdict, such as a failed deep pass over changed files or an unresolved material trigger.
- If all findings are weak, return an empty findings array. Empty is good.
```

Add this output instruction:

```md
Before returning, ensure every kept P0/P1/P2 has a corresponding `checked[]` entry beginning with `EVIDENCE finding:`. If the evidence cannot be stated concretely, delete the finding.
```

---

## Section D — tests and evaluation harness

### Unit tests to add now

1. **CLI ignored-flag tests**

   * `--github --pr 1 --base develop` rejects or carries base intentionally.
   * `--github --pr 1 --focus security` rejects or carries focus intentionally.
   * `--repo=`, `--base=`, and `--focus=` reject empty values.

2. **Normalization invariant tests**

   * `normalizeFinding` rejects `lineEnd < lineStart`.
   * blocking findings below confidence threshold are rejected if you add that rule.
   * residual risks with empty text are dropped or rejected.
   * map hotspots with non-changed files are rejected or filtered by a new helper.

3. **Process tests**

   * missing command reports `res.error`.
   * non-zero command includes stderr.
   * timeout behavior is deterministic if timeout is added.

4. **Verdict tests**

   * P3-only findings produce `pass`, matching README semantics. The README says P3-only findings do not block. 

5. **Render tests**

   * residual blocking risks render visibly.
   * findings sort P0 → P3.
   * optional `consumerFile`/`consumerLine` are rendered once those fields become meaningful.

### Orchestration tests

Add a tiny dependency seam so `review()` can run with fake Codex responses. Then test:

1. **Small review path**

   * fake proposal returns two findings;
   * fake critic prunes one;
   * verdict derives from pruned findings, not proposal findings.

2. **Large review path**

   * fake map returns hotspots;
   * fake deep returns findings and residuals;
   * fake critic prunes;
   * tail coverage is added for unmapped files.

3. **Deep failure path**

   * one deep pass throws;
   * result becomes `needs_human` unless critic legitimately clears the blocking residual.

4. **Malformed model output**

   * invalid JSON fails cleanly;
   * one malformed finding does not create a partial, misleading review unless intentionally using loose mode.

### GitHub Action harness

Use fake `git` and `gh` executables on `PATH`; do not add dependencies.

Scenarios:

1. **Successful changes_requested**

   * fake `gh api repos/.../pulls/N` returns base/head;
   * fake review POST payload is captured;
   * fake check-run payload has `conclusion: "failure"`.

2. **Successful pass**

   * review event is `COMMENT`, not `APPROVE`, matching README policy. 

3. **Inline comment failure**

   * first review POST returns non-zero;
   * fallback body-only POST occurs;
   * check-run still posts.

4. **Review crash**

   * Codex throws;
   * no PR approval/comment is posted as success;
   * failed check-run is posted, matching the code’s failure path. 

### Prompt/code-review quality eval harness

Create `eval/fixtures/*`, each fixture being a tiny git repo or patch bundle with an expected outcome file. Do not require exact wording; assert tags and evidence.

Include at least these positive fixtures:

1. over-block shared predicate rejects one legitimate action;
2. aggregate loop exceeds caller timeout and can leave partial persisted state;
3. changed sentinel reaches a downstream guard and rejects a live path;
4. CLI flag parsed but ignored;
5. GitHub workflow permission or token exposure regression;
6. dependency/install script supply-chain regression;
7. migration/schema compatibility break;
8. duplicate behavior where a new flag/config reimplements an existing one.

Include negative fixtures:

1. style-only refactor;
2. docs-only change;
3. test-only change;
4. safe predicate tightening where every call-site is legitimately governed;
5. loop with proven product under timeout;
6. dependency patch update with no invoked API/contract change;
7. missing tests with no concrete bug path;
8. harmless internal helper default.

Metrics to record per run:

* recall by defect class;
* false positives per negative fixture;
* invalid JSON rate;
* blocking residual-risk rate;
* line-anchor validity;
* cross-file evidence validity;
* critic prune rate;
* runtime and Codex call count.

The key is to evaluate **finding tags and evidence**, not prose. For example:

```json
{
  "expected": {
    "verdict": "changes_requested",
    "mustFind": ["over_block:shared_predicate_blocks_legitimate_action"],
    "mustNotFind": ["style", "missing_tests_only"],
    "requiresConsumerCitation": true
  }
}
```

---

## Section E — risks in these recommendations

The biggest risk is making Needlefish **too conservative**. Confidence floors, stricter schema validation, and stricter critic evidence rules will reduce false positives, but they may initially drop real findings whose evidence is poorly formatted. Mitigation: add the eval harness before or alongside stricter normalization.

The second risk is that forcing `--deep` into the map/deep path will increase cost and latency. The README already frames `--deep` as wider context, so the behavior would be more honest, but it should be documented.

The third risk is over-hardening GitHub auth. Setting `GH_CONFIG_DIR` to an empty directory inside Codex may prevent Codex from using `gh` for read-only inspection, but the prompts already rely mainly on `git diff`, `git show`, `rg`, `sed`, and `nl`, not authenticated GitHub calls.  That tradeoff is worth it for read-only identity.

The fourth risk is prompt bloat. The current prompts are already long, especially `review.md` and `deep.md`. The edits above should replace vague or duplicated language rather than simply append more text. The goal is not “more instructions”; it is **more checkable output**.

The fifth risk is building too much test infrastructure. Keep the first harness simple: fake Codex, fake gh, tiny fixture repos, JSON expectations. Do not add a full eval platform or new dependencies until the small harness proves useful.
