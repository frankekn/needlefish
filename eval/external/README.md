# External benchmark manifest contract

The offline importer checks a frozen manifest and exports source material separately from evaluator metadata. The separate result scorer imports structured product captures and independent evaluator data. Neither command runs reviews, creates mirrors, or replaces Needlefish's Class R or Class D gates. Issue #193 remains open.

## Run an import

Use Node 20 or later and the repository's pinned pnpm environment.

```sh
pnpm exec tsx eval/external/import.ts eval/external/samples/swrbench-pytest-3248.json /tmp/pytest3248-import
```

The input must be a regular UTF-8 file. The CLI reads at most 250,001 bytes and rejects manifests over 250,000 bytes before decoding or creating output. A nonblocking open lets it reject FIFOs without waiting for a writer. The output directory must not exist. The command prints `excluded` and writes `evaluator.json`. Both committed real samples are metadata observations, so neither creates a `reviewer` directory. This is the expected result, not an operational review failure or a clean review.

With a separately prepared local repository, add `--repo /path/to/local/repo`. The tool never fetches, checks out, or runs target code. It reads exact git objects through a temporary empty bare Git directory that points at the local object database. Target configuration and attributes cannot affect the patch. External diff, textconv, hooks, fsmonitor, GPG signature helpers, replacement objects, lazy fetch, and ambient Git configuration are disabled. The temporary directory is removed after verification. Partial clones are rejected. There is no network mode. Each git command has a five-second timeout and an eight-MiB output limit. Each tree has at most 1,000 regular UTF-8 files and eight MiB of content. At most 100 files may change.

A frozen manifest must supply the source base, review base and head, expected source merge base, ordered commit SHAs, tree SHAs, exact patch SHA-256, and frozen title, description, and policy with hashes. The verifier requires a linear series in which every commit has exactly one expected parent. Merge commits, missing objects, incompatible lineage, empty or mismatched patches, binary or non-UTF-8 files, symlinks, submodules, and unsupported paths produce explicit exclusions.

Paths preserve exact UTF-8 names, including route brackets, spaces, parentheses, quotes, leading hyphens, and Unicode. Names have at most 2,000 Unicode code points. Absolute paths, empty or dot path components, Unicode control characters (`Cc`), bidirectional controls (`Bidi_Control`), unpaired surrogates, and backslashes are excluded. Other Unicode format characters, including ZWJ and ZWNJ, remain supported. Colons are excluded to reject Windows drive and alternate-stream forms. No Unicode normalization or case folding occurs. Wildcards and shell-looking names remain literal data in Git arguments and JSON. The importer exports names in JSON and never materializes them as files. These limits exclude the whole snapshot; they never drop individual files.

The patch hash covers git's two-point textual diff with full-width blob IDs, three context lines, Myers algorithm, no indent heuristic, no renames, `a/` and `b/` prefixes, and no external diff or textconv. The verifier computes its hunk map from those same frozen endpoints. A truncated supplied patch hash cannot pass by omitting the unparsed tail.

## Output ownership

`reviewer/input.json` exists only after local object validation succeeds. Its keys are explicitly constructed from the frozen title, description, policy, base and head files, diff, hunk map, and code identity hashes. It contains no dataset ID, source URL, evaluator label, gold count, review timeline, comments, subsequent fixes, final PR head, or other tools' findings. Never pass the parent output directory or original dataset to a reviewer. Give the reviewer only `reviewer/input.json` in a separate isolated workspace.

`evaluator.json` retains source provenance, the historical and observed heads, label metadata, exclusions, and scoring limitations. Source response hashes are recorded observations, not claims that this importer reauthenticated the original bytes. A slice hash covers only its declared byte range, never the full SWRBench JSONL. The strict JSON boundary rejects extra keys, including raw dataset timeline or comment fields. It cannot prove that an operator-supplied title or policy contains no semantic answer leak. Curators must freeze these from the allowed source before viewing tool results.

Source readiness does not grant publication or scoring readiness. The manifest always reports upstream code licensing as `unknown`; this tool does not redistribute an upstream code mirror. Obtain and preserve the license at each exact upstream code revision before public mirroring. The full dataset or a large clone needs separate resource authorization.

## Fixed examples and provenance

The examples contain small metadata derived from official published data and bounded GitHub API observations on 2026-10-16. They include no gold descriptions or source code. `samples/evidence.json` records the observation hashes and pytest lineage evidence. Those hashes identify prior observations; the raw responses were not retained here. The catalog has no batch import or automatic sample selection.

- Martian `calcom/cal.com#8087` has two published gold comments. Its current canonical repository is `calcom/cal.diy`. The observation fixes base `ba9688a04a8398c9a8332ee7061bfae2f2efd524` and head `820d7fa87e0c824c5dee8082a33efadb1a2566f7`. Historical snapshot equivalence, parent series, code objects, and location annotations remain unknown. Gold is unscorable without locations.
- SWRBench `pytest-dev/pytest#3248` fixes dataset head `6e14585ca20d27db81f122d2c3a76135e4192fc4` and its parent `053fc118b7af3b77c42daddd6ceacd13394cf64a` as the review base. Dataset `base_commit` is `dae74b674ecb660082271d8bbe0e42ccb925eaa5`; its comparison is diverged, ahead one and behind five. The observed final PR head is `147b43f83216c612ab0122c8a3961895c4222abe` and is never substituted. The clean label records `change_introduced=false` and `changes=[]`; it does not prove every new finding is false.

Official datasets and notices are fixed at these revisions.

- [Martian Code Review Benchmark](https://github.com/withmartian/code-review-benchmark/tree/e616e849755441da38f18bf3adba2c9583b03803). The metadata derives from `offline/golden_comments/cal_dot_com.json`. Its MIT notice is preserved in `licenses/martian-MIT.txt`, copyright 2025 Martian.
- [SWRench Software Review Benchmark](https://github.com/ZZR0/SWRench/tree/67ae1d4395ac05f800d62b0e13678eadeb9fa5c7). The metadata derives from the byte range `60000000-60131071` of `data/swr_datasets_d5c5.jsonl`. Its MIT notice is preserved in `licenses/swr-MIT.txt`, copyright 2026 ZZR0. This is unrelated to the React SWR performance project and Spectral World Renderer datasets.

## Remaining campaign decisions

The source importer still reports `comparisonStatus: NOT_RUN` and `scoringStatus: unscorable`. The result scorer below supplies a versioned description-and-location rubric. Before a real campaign, freeze severity scope, sampling rules, independent judge identities, blind adjudication, and product capture procedures. The study has no fixed negative cohort size yet.

A factual false positive requires adjudication. Keep unmatched candidates distinct from proven false positives, including on clean samples. Martian gold needs independently curated file, side, and accepted line ranges before description-plus-location scoring. Any gold revision requires a new version and consistent recomputation for all products while retaining frozen-gold results. Hosted product scope, quotas, receipts, and historical contamination remain separate checks.

## Import product results and score one PR

```sh
pnpm exec tsx eval/external/score.ts manifest.json independent-evaluator.json product-results.json /tmp/new-scores.json --repo /path/to/local/repo
```

The scorer repeats local Git object admission using the original manifest. It never trusts an operator-written `source-ready` flag or reviewer JSON. Missing local objects or an excluded manifest produce `excluded` attempts with null metrics. The two committed real samples remain excluded even if an operator supplies gold and product results.

Each input is a regular UTF-8 JSON file. Manifest input retains the 250,000-byte limit. Evaluator and result files each have a 2,000,000-byte limit. Inputs reject unknown fields. The output file must not exist and is created with mode `0600`. An invalid input exits nonzero before writing output. A valid report prints `evaluated` even when individual attempts are operational or unscorable. Read each attempt's status and metrics; CLI exit zero is not a clean review or a qualification result.

### Product capture contract

`product-results.json` has this shape. The example hashes identify synthetic data only.

```json
{
  "schemaVersion": 1,
  "binding": { "manifestSHA256": "<64 lowercase hex>", "reviewerSHA256": "<64 lowercase hex>" },
  "product": {
    "name": "Needlefish",
    "version": "<exact product version>",
    "configurationSHA256": "<64 lowercase hex>",
    "source": { "identity": "<retained raw result artifact>", "sha256": "<64 lowercase hex>" }
  },
  "attempts": [{
    "id": "attempt-1",
    "status": "completed",
    "format": "needlefish-capture-v1",
    "findings": [{
      "id": "finding-1",
      "title": "Zero divisor",
      "whyItBreaks": "A zero divisor causes the request to fail.",
      "file": "src/value.ts",
      "side": "head",
      "lineStart": 10,
      "lineEnd": 10
    }]
  }]
}
```

The product names and capture formats are fixed. These are explicit export contracts, not guessed parsers for vendor Markdown or an assertion that a hosted API exposes these fields. An operator captures every actionable finding from the retained original result without severity filtering or deduplication, assigns stable finding IDs, and preserves the original result artifact separately. Source and configuration hashes are recorded identities; the scorer does not fetch or reauthenticate those artifacts. Product collection and completeness need independent verification in a real study.

| Product | Capture format | Finding fields |
| --- | --- | --- |
| `Needlefish` | `needlefish-capture-v1` | `id`, `title`, `whyItBreaks`, `file`, `side`, `lineStart`, `lineEnd` |
| `Codex review` | `codex-review-capture-v1` | `id`, `title`, `body`, `code_location` with `file`, `side`, `start`, `end` |
| `CodeRabbit` | `coderabbit-capture-v1` | `id`, `body`, `path`, `side`, `start_line`, `line` |

Needlefish and Codex use `base` or `head`. CodeRabbit uses `LEFT` or `RIGHT`, which map to base and head. Paths are exact repository-relative paths and use the same path domain and length limit as source admission. No basename matching or implicit absolute-path stripping occurs. All locations use positive inclusive line numbers. Reversed ranges and traversal paths are invalid. The normalized description is the title plus explanation for Needlefish and Codex, or the comment body for CodeRabbit.

An attempt that did not produce a complete structured capture instead has `id`, `status`, and `reason`. Allowed statuses are `operational`, `incomplete`, `skipped`, `truncated`, and `raw`. These attempts have null metrics and retain their status and reason. A timeout, error, partial coverage, unparsed Markdown, or skipped review must use that form. Never convert it to a completed empty finding array. The scorer cannot detect a dishonest completeness declaration in a manually supplied capture.

### Independent evaluator contract

The evaluator uses the same `schemaVersion` and `binding`, with these additional fields.

```json
{
  "independent": { "identity": "<blind evaluator>", "version": "<oracle revision>", "sourceSHA256": "<retained evaluator data hash>" },
  "gold": {
    "status": "ready",
    "provenance": "<independently frozen gold source>",
    "findings": [{
      "id": "gold-1",
      "description": "A zero divisor fails the request.",
      "location": { "path": "src/value.ts", "side": "head", "start": 10, "end": 10 }
    }]
  },
  "attempts": [{
    "id": "attempt-1",
    "attemptSHA256": "<exact captured attempt hash>",
    "adjudications": [{
      "findingId": "finding-1",
      "descriptionGoldIds": ["gold-1"],
      "unmatched": "unresolved",
      "rationale": "The description identifies the same defect and trigger."
    }]
  }]
}
```

The independent evaluator freezes gold before inspecting product results. For each result finding, the evaluator decides whether its description meaningfully identifies each referenced gold defect, including the cause and consequence. `descriptionGoldIds` records only confirmed semantic equivalence. Keyword overlap alone is insufficient. The software does not infer this human judgment from a regular expression, and the evaluator's declared identity is not proof of independence or truth.

`unmatched` supplies the independent disposition only when a finding has no eligible gold candidate. A candidate requires confirmed description equivalence and an exact path, side, and full-range match. A finding with a candidate but no allocation is a derived `duplicate`; its `unmatched` disposition is ignored. Use `legitimate` for an independently confirmed sibling defect outside frozen gold, `false_positive` for a disproved claim, and `unresolved` when the available evidence does not settle it. Each judgment requires a rationale. Missing finding adjudications make the attempt unscorable. Unknown finding IDs, gold IDs, duplicate attempt IDs, duplicate finding IDs, duplicate gold IDs, and duplicate finding adjudications are rejected.

When locations or independent gold are unavailable, use `gold: { "status": "unavailable", "reason": "gold_locations_missing" }`. Such attempts are unscorable. A ready gold list may be empty only when an independent evaluator has admitted the clean cohort. The historical manifest's clean label alone does not establish that any new finding is false. Historical manifest label and gold count remain recorded observations; revised independent gold has its own provenance and version and must be applied equally to every product.

### Frozen identities and separation

`sourceBinding(manifest, reviewer)` returns SHA-256 of `JSON.stringify` of the parsed manifest and the admitted reviewer object. `attemptSHA256(attempt)` returns SHA-256 of `JSON.stringify` of that captured attempt. These exported functions define the encoding, including object key order. Formatting the original JSON file does not change identity. Changing object key order does. Evaluator attempt identities bind the exact descriptions and locations, so editing a product finding invalidates its old judgments. Foreign source identities and out-of-snapshot gold locations are rejected.

The evaluator file and product captures are scoring inputs only. The scorer never writes or changes `reviewer/input.json`. Unknown evaluator, private, timeline, and product fields cannot enter the source importer's explicit reviewer object. Do not give reviewers either scoring file, the parent import directory, credentials, or raw dataset metadata. This boundary does not detect semantic answer leaks that a curator inserts into an otherwise permitted title or policy.

### Description-and-location rubric

The rubric is `external-description-location-v2`. A match requires an independent description-equivalence judgment and the exact path and side. The finding's entire inclusive line range must lie inside the gold's accepted inclusive range. There is no extra location tolerance. Gold locations must exist in the admitted frozen tree. One finding matches at most one gold, and one gold matches at most one finding. Maximum bipartite allocation prevents an early ambiguous match from consuming the only match for another finding. Allocation may choose different finding IDs when the input order changes, but all metrics remain unchanged.

The strict full-range rule can favor products that report shorter ranges. A real comparison campaign must freeze a comparable location policy before collecting product results. This diagnostic rubric retains the strict rule without adding tolerance.

Each PR report retains separate attempts, product version and configuration, source identity, evaluator identity, full parsed evaluator and result hashes, matches, and actual counts. It does not select the best attempt or silently discard failures. Counts are `matched`, `missed` unallocated frozen gold, derived `duplicate`, independently confirmed `falsePositive`, `legitimateUnmatched`, `unresolved`, `findingCount`, and `goldCount`. Unresolved findings are never automatically false positives. Duplicates count as neither matches nor false positives.

Recall has numerator `matched` and denominator `goldCount`, regardless of unresolved findings. Precision has numerator `matched + legitimateUnmatched` and denominator `findingCount`, including duplicates. Only precision is null when unresolved findings remain, while the confirmed counts are retained. A zero denominator produces null, never a perfect score. A completed empty review against positive gold has zero recall and misses all gold. A completed empty review against admitted clean gold has zero counts with null rates. Operational and unscorable attempts carry no rate denominators and must be reported separately in any later campaign aggregation.

This diagnostic scorer does not change the production fixture scorer, qualification policy, model input, or running frozen campaign. It supplies no R or D qualification. The 50 Martian snapshots with independently located gold, an admitted clean cohort, real three-product captures, costs and versions, and a public reproducible comparison remain unfinished.

## Verify the contract

```sh
NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS=100 node --test --test-concurrency=1 --import tsx eval/external/manifest.test.ts eval/external/results.test.ts
pnpm check
pnpm lint
```

The grace setting mirrors `scripts/test.mjs`; these two test files do not depend on runner timeouts.

The tests use real temporary git repositories, inspect exported JSON bytes, change evaluator metadata without changing reviewer bytes, and reject wrong heads, parent DAGs, missing objects, tree mismatches, truncated-patch hashes, binary content, local diff configuration, target GPG helpers, UTF-8 byte order marks, oversized input, non-regular input files, and unrelated objects sharing a seven-hex blob prefix. They do not execute upstream code or invoke a model.

Path controls exercise real Git object names, literal wildcard arguments, distinct Unicode spellings, the shared 2,000-code-point bound, and all three capture formats through the import and score CLIs. Unsafe paths and malformed UTF-8 cannot enter reviewer output. Existing file modes and snapshot limits remain enforced.
