# External benchmark manifest contract

This offline tool checks one frozen manifest and exports source material separately from evaluator metadata. It does not run reviews, score findings, create mirrors, or replace Needlefish's Class R or Class D gates. Issue #193 remains open.

## Run an import

Use Node 20 or later and the repository's pinned pnpm environment.

```sh
pnpm exec tsx eval/external/import.ts eval/external/samples/swrbench-pytest-3248.json /tmp/pytest3248-import
```

The input must be a regular UTF-8 file. The CLI reads at most 250,001 bytes and rejects manifests over 250,000 bytes before decoding or creating output. A nonblocking open lets it reject FIFOs without waiting for a writer. The output directory must not exist. The command prints `excluded` and writes `evaluator.json`. Both committed real samples are metadata observations, so neither creates a `reviewer` directory. This is the expected result, not an operational review failure or a clean review.

With a separately prepared local repository, add `--repo /path/to/local/repo`. The tool never fetches, checks out, or runs target code. It reads exact git objects through a temporary empty bare Git directory that points at the local object database. Target configuration and attributes cannot affect the patch. External diff, textconv, hooks, fsmonitor, GPG signature helpers, replacement objects, lazy fetch, and ambient Git configuration are disabled. The temporary directory is removed after verification. Partial clones are rejected. There is no network mode. Each git command has a five-second timeout and an eight-MiB output limit. Each tree has at most 1,000 regular UTF-8 files and eight MiB of content. At most 100 files may change.

A frozen manifest must supply the source base, review base and head, expected source merge base, ordered commit SHAs, tree SHAs, exact patch SHA-256, and frozen title, description, and policy with hashes. The verifier requires a linear series in which every commit has exactly one expected parent. Merge commits, missing objects, incompatible lineage, empty or mismatched patches, binary or non-UTF-8 files, symlinks, submodules, and unsupported paths produce explicit exclusions. Paths currently accept ASCII letters, digits, `.`, `_`, `/`, `@`, `+`, and `-`. These limits exclude the whole snapshot; they never drop individual files.

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

All imports report `comparisonStatus: NOT_RUN` and `scoringStatus: unscorable`. Before a campaign, freeze a common rubric, severity scope, description equivalence, location tolerance, negative count and sampling rules, judge version, blind adjudication process, and treatment of operational failures. This tool chooses none of those policies.

A factual false positive requires adjudication. Keep unmatched candidates distinct from proven false positives, including on clean samples. Martian gold needs independently curated file, side, and accepted line ranges before description-plus-location scoring. Any gold revision requires a new version and consistent recomputation for all products while retaining frozen-gold results. Hosted product scope, quotas, receipts, and historical contamination remain separate checks.

## Verify the contract

```sh
node --test --import tsx eval/external/manifest.test.ts
pnpm check
pnpm lint
```

The tests use real temporary git repositories, inspect exported JSON bytes, change evaluator metadata without changing reviewer bytes, and reject wrong heads, parent DAGs, missing objects, tree mismatches, truncated-patch hashes, binary content, local diff configuration, target GPG helpers, UTF-8 byte order marks, oversized input, non-regular input files, and unrelated objects sharing a seven-hex blob prefix. They do not execute upstream code or invoke a model.
