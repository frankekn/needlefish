# eval/tools

Command-line tools that read GitHub. None of them run in `pnpm test` against
the network; their tests stub `gh`.

- `pr2fixture.ts` mines a real PR into a fixture skeleton. See
  [`eval/fixtures-real/README.md`](../fixtures-real/README.md).
- `adoption.ts` measures how often real PRs act on Needlefish inline findings.

## adoption

```
npx tsx eval/tools/adoption.ts owner/name [owner/name ...] [--since YYYY-MM-DD] [--json]
```

Needs an authenticated `gh` with read access to every listed repo. There is no
default repo list.

A finding thread is a PR review thread whose first comment starts with a
Needlefish header (`**P2** title`, or the early `**P2 (category): title**`).
Its fate:

| fate | rule |
| --- | --- |
| addressed | PR merged and GitHub marks the thread outdated (its lines changed after posting) |
| kept | PR merged and the thread is not outdated |
| pending | PR still open |
| abandoned | PR closed without merge |

Adoption rate = addressed / (addressed + kept). The Markdown report splits it
by repo, severity, category, and ISO week of the thread's creation. Category
comes from the early header when present, otherwise from the round-state marker
in Needlefish's review body matched by normalized title, otherwise `unknown`.

`--since` counts only threads created on or after that UTC date and stops
paging at the first PR last updated before it. For the weekly report, pass the
date seven days back. `--json` prints the raw per-thread rows instead of the
report.

Limits: outdated is a proxy. A rebase or an unrelated edit to the same lines
also marks a thread outdated, and a fix made elsewhere in the file does not.
Only the first 100 review threads per PR are read; the tool warns on stderr when
a PR has more.
