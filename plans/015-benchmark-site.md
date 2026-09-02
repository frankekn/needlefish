# Plan 015: Readable repo and domain-ready benchmark page

## Goal

Make Needlefish understandable from the first screen and publish benchmark results without hiding runner/provider effects.

Success:

- README answers what Needlefish does, how to try it, and where current results live in the top third.
- A static benchmark page shows only comparable, complete reports in its ranked table.
- Every lane names model, runner/harness, provider, subscription route, and effort separately.
- Raw reports and methodology remain one click away.
- The page works at a repository URL now and a custom domain later.

Non-goals: CMS, backend, accounts, public submissions, analytics, live API data, new chart or site dependencies, domain purchase, DNS, deploy, or benchmark-policy changes.

## Primary examples

| Example | Pattern worth copying | Do not copy |
| --- | --- | --- |
| [SWE-bench site](https://www.swebench.com/) / [site repo](https://github.com/swe-bench/swe-bench.github.io) | Leaderboard is the product surface; JSON-driven rows link to date, logs, trajectories, verification, and source. Its [submission contract](https://github.com/swe-bench/experiments/blob/main/checklist.md) requires model/system metadata and a report. | Multiple benchmark-family navigation and submission workflow. |
| [aider Polyglot leaderboard](https://aider.chat/docs/leaderboards/) / [harness](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md) | Short definition and dataset size precede the table. Rows keep score, cost, command, and format validity readable; expandable details disclose effort, commit, errors, time, date, version, and cost. | Hundreds of expanded fields in the default view. |
| [LiveBench](https://livebench.ai/) / [repo](https://github.com/LiveBench/LiveBench) / [site repo](https://github.com/LiveBench/new-livebench) | Leaderboard, data, and methodology are separate first-class links. Release-scoped data and optional cost fields prevent missing cost from becoming fake zero. The official site repo uses static release files and GitHub Pages. | React and category drill-down; Needlefish has one benchmark and does not need an app. |
| [Terminal-Bench](https://www.tbench.ai/) / [repo](https://github.com/harbor-framework/terminal-bench) | First viewport is version, one-line purpose, two links, then leaderboard. Model and agent are separate columns; the metric and confidence interval are stated beside the chart. Exact run commands include agent, model, effort, and environment. | Marketing sections before results. |

## Page information architecture

### First viewport

1. `Needlefish benchmark`
2. One sentence: “Which model + review harness catches real PR defects without blocking clean changes?”
3. Links: `Use Needlefish`, `Methodology`, `Raw reports`, `GitHub`.
4. Current release/date plus four trust facts: fixture count, x3 policy, sealed holdouts, anti-cheat generation.
5. Current production decision, then the leaderboard; no news feed or feature cards above it.

### Canonical leaderboard

Default columns:

| Lane | Provider | Effort | Balanced score | Anchored recall | Usable specificity | Tier-1 | False positive | Invalid | Mean time | Status |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |

`Lane` displays runner/harness and model as separate lines. Provider must name the actual subscription/API route used; never infer “model quality” from a different provider or silently substitute OpenRouter.

Each row uses native `<details>` for:

- exact model ID, runner/harness and version;
- provider and subscription product, without account or credential data;
- effort, draw count, date, git SHA;
- prompt, fixture-set, scorer, and anti-cheat hashes;
- raw JSON and chronological result-note links.

Incomplete, compromised, pre-guard, or hash-mismatched reports do not receive a rank. Put them in `Historical / not comparable` with the exact reason. Provider-catalog blocks belong in `Not run`, not as zero scores; for example, `Qwen3.8-Flash-Next — unavailable on the checked subscription endpoint` until a subscribed provider exposes it.

### Chart

One compact inline SVG scatter plot: anchored recall on x, false-positive rate on y, labels on points. Include only the same comparable set as the table and keep the table canonical. Omit the chart if fewer than three comparable lanes remain.

### Methodology and caveats

State, without collapsing into marketing prose:

- what the fixtures represent and which are positive, negative, honeypot, real-PR, and sealed holdout;
- Balanced Review Accuracy, anchored recall, usable specificity, Tier-1 disqualification, false-positive, invalid-output, and verdict-match definitions;
- x1 is directional and promotion requires full-set x3;
- comparisons require matching `promptHash`, `fixtureSetHash`, `scorerHash`, and `anticheatVersion`;
- runner/provider errors are operational failures, not demonstrated model quality;
- provider, subscription route, runner, model, and effort together define a lane;
- raw report, exact command, git SHA, and release links.

Reuse the integrity/completeness rules already enforced by `eval/gen-results.ts`; the page must not invent a second eligibility policy.

## README structure

Keep `README.md` and `README.zh-TW.md` in the same order:

1. Name + one-line value.
2. `npx needlefish` and one short output example.
3. Links: benchmark page, GitHub Action, methodology.
4. Three-row current benchmark snapshot with “updated” date; link to the page for all lanes.
5. Local use and GitHub Action.
6. How the review pipeline and deterministic verdict work.
7. Trust/isolation boundaries.
8. Machine interface, development, self-hosted details, and status.

Move the long benchmark doctrine and chronological experiments out of the README; link to the page and `eval/RESULTS.md`. Do not duplicate version strings or full score tables in several files.

## Minimal implementation

1. Add one small curated manifest, `eval/leaderboard.json`, keyed by exact report path. Store only display name, provider/subscription route, public status, and optional note; derive all scores and provenance from the report JSON.
2. Extend the existing results generator to validate manifest paths and emit `docs/index.html`. Use semantic HTML, native `<details>`, an inline SVG, and inline CSS; add no dependency or frontend build.
3. Fail generation when a published row lacks provider, runner, model, effort, hashes, complete draws, or a raw-report link. Render blocked/not-run entries separately.
4. Restructure both READMEs and link the generated page.
5. Verify generator tests, `pnpm check`, `pnpm test`, local narrow/mobile rendering, keyboard navigation, visible focus, table overflow, contrast, and that every raw link resolves.
6. Run `$autoreview` because generated HTML, config, and user-facing docs cannot skip it.

Expected shipping files: the two READMEs, `eval/leaderboard.json`, the existing generator/test, and generated `docs/index.html`. No JavaScript bundle.

## Domain and deployment

Build with relative URLs so the same bytes work under `/needlefish/` and a domain root. Prepare `docs/` for GitHub Pages, but do not add a placeholder `CNAME` or change repository Pages settings before the domain exists.

After purchase:

1. Verify the domain with GitHub.
2. Configure the exact domain in repository Pages settings.
3. Add the required DNS record, then enforce HTTPS after it becomes available.
4. If Pages publishes from the branch `docs/` source, retain the generated `CNAME`; custom Actions publishing does not require it. See [GitHub’s custom-domain procedure](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

## Anti-patterns

- Do not rank different hashes, partial runs, or x1 beside confirmed x3 as peers.
- Do not merge model, agent/runner, provider, and effort into one opaque name.
- Do not report provider failures as model misses or missing cost as `$0`.
- Do not use color or emoji as the only status signal.
- Do not put the per-fixture matrix, experiment diary, or raw JSON on the landing page.
- Do not hand-copy scores into HTML; generate them from guarded reports.
- Do not add search, sorting, dark-mode logic, frameworks, chart libraries, or submission accounts until row count or user evidence requires them.
