---
target: needlefish benchmark page
total_score: 31
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 1
timestamp: 2026-09-08T04-50-36Z
slug: docs-index-html
---
# Critique: Needlefish benchmark page (docs/index.html)

Method: dual-agent (A: agent-1 · B: agent-2)

## Design Health Score: 31/40 (Good)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Lane statuses + freshness exist; "Updated" date and hashes buried in last section |
| 2 | Match system / real world | 2 | Intro packs 4 undefined insider terms (lane, anchored recall, usable specificity, hard gates); trust-rail labels opaque |
| 3 | User control and freedom | 3 | Skip link, anchors, native disclosures; core inspect action visually broken (P0) |
| 4 | Consistency and standards | 3 | .status-disqualified emitted but unstyled; dead .status-production rule; model-name wrap differs open vs closed |
| 5 | Error prevention | 3 | Build-time validation strong; disqualified GLM 94.81% out-scores deployed Terra 89.95% in number-first layout |
| 6 | Recognition over recall | 3 | Scatter plot carries zero numeric values |
| 7 | Flexibility and efficiency | 3 | Raw report/reproduce accelerators good; 4 diagnostic columns hidden behind undiscoverable desktop scroll |
| 8 | Aesthetic and minimalist | 4 | Disciplined; mast cyan/orange data line encodes nothing |
| 9 | Error recognition/recovery | 4 | Disqualified/blocked/voided runs published with reasons and raw links |
| 10 | Help and documentation | 3 | Method thorough; definitions arrive 3 screens after first use |

## Design Specificity Verdict

LLM assessment: authored for this product, not interchangeable. Evidence classes map onto gate discipline; reproduce commands, hashes, anti-cheat generation per lane; marine-bulletin metaphor coherent.

Deterministic scan (degraded regex mode — selector rules not evaluated, undercount): 6 off-palette colors (2 prose-sanctioned by DESIGN.md: green/brown status), 7 off-ramp font sizes, em-dash warning is FALSE POSITIVE (103 of 108 are --flags in code).

Visual overlays: SKIPPED — no Playwright/Puppeteer installed; headless-Chrome screenshots used as browser evidence instead.

## Priority Issues

- [P0] Evidence disclosure unreadable when opened (all viewports): dl grid trapped in ~74-98px Model cell, values wrap one char per line, open row 10,756px tall. Fix: full-width evidence slip / colspan companion row. (Both assessments agree.)
- [P1] Rank 1 is "Candidate" Grok 4.6 (95.48%), deployed Terra is 89.95% — "Candidate" never defined; central narrative tension unexplained. Fix: one sentence in decision block + status legend.
- [P2] Rank ties 1,2,2 + overlapping CIs read self-contradictory; tie rule explained 3 screens later. Fix: footnote marker on Rank header to #method.
- [P2] Four diagnostic columns (Harness/Provider/Effort/Mean time) undiscoverable on desktop; scroll hint hidden >760px. Fix: show hint at all widths.
- [P3] Mast min-height 88vh fragile (1300px dead field at 1440x2400, trust rail sliced at 900px fold); cyan/orange line hardcoded 54%/57%, encodes nothing. Fix: cap mast height; bind line to real stat or drop orange.

## Persona Red Flags

- Jordan: undefined jargon before definition; can't reconcile rank-1 Candidate vs deployed; thinks ranking broken (94.81 > 89.95).
- Sam: skeleton good (skip link, landmarks, AA contrast all pass); skip target #leaderboard non-focusable section; no status legend; sighted keyboard users get mangled disclosure.
- Alex: finds winner fast, loves raw evidence; reproduce command renders vertically when disclosed; no updated-date near table.

## Minor Observations

- Plot yMax zero headroom: worst lane straddles x-axis (gen-site.ts:996)
- No numeric ticks on plot
- Stale comment "86 x 3" vs rendered 87 (gen-site.ts:1126)
- Dead .status-production CSS; .status-disqualified unstyled — failure state is the only hue-less status
- No print stylesheet: white mast text prints invisibly
- Closed rows wrap model names mid-token ("GPT-/5.6/Terra"); Model column needs min-width ~11ch
- summary font-weight 750 rounds to 700 without variable Avenir
- Disqualified table clips mid-value ("95.0") at right edge
- Touch targets: nav links 22px, footer links 16-17px (below 24px WCAG 2.5.8)
- Live site byte-identical to local (md5 3d8124bf...)

## Questions to Consider

1. The most trusted gesture (open a lane's evidence) is the most broken surface — no reviewer ever clicked a lane name at desktop width?
2. Is the mast answering "which reviewer catches bugs" or "which we might use someday"?
3. Why does the one unexplained decoration (mast data line) survive at the top of an evidence-first page?
