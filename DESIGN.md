---
name: Needlefish Benchmark
description: A public marine observation bulletin where benchmark evidence is the product.
colors:
  deep-ocean-ink: "#071f2b"
  harbor-muted: "#49636d"
  paper-white: "#f5f7f3"
  pure-white: "#ffffff"
  data-cyan: "#bdebf1"
  evidence-blue: "#0c5670"
  exception-orange: "#c44724"
  chart-line: "#bfd0d2"
typography:
  display:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "clamp(3.4rem, 9vw, 6rem)"
    fontWeight: 600
    lineHeight: 0.86
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "clamp(2.2rem, 5vw, 4rem)"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Avenir Next, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Avenir Next, Segoe UI, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.07em"
  measurement:
    fontFamily: "ui-monospace, SFMono-Regular, monospace"
    fontSize: "1.15rem"
    fontWeight: 700
    lineHeight: 1
rounded:
  focus: "3px"
  scrollbar: "8px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "13px"
  md: "18px"
  lg: "28px"
  section: "88px"
components:
  status:
    backgroundColor: "transparent"
    textColor: "{colors.deep-ocean-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "4px 9px"
  leaderboard:
    backgroundColor: "{colors.pure-white}"
    textColor: "{colors.deep-ocean-ink}"
    rounded: "0"
  evidence-link:
    textColor: "{colors.evidence-blue}"
    typography: "{typography.body}"
---

# Design System: Needlefish Benchmark

## Overview

**Creative North Star: "The Marine Observation Bulletin"**

Needlefish presents evaluation evidence as a public bulletin from a working marine observatory: sober, exact, and legible at a glance. The page is a single light paper field; deep-ocean ink carries text and the strongest structural rules, cyan marks data infrastructure, and orange marks exceptions that deserve attention.

The system is editorial rather than promotional. Oversized questions create entry points, compact measurement type carries proof, and ruled tables expose the comparable evidence before any explanatory narrative. It refuses generic marketing cards and decorative dashboard chrome.

**Key Characteristics:**

- Leaderboard-first editorial hierarchy
- Deep ink and paper surfaces divided by crisp data lines
- Serif questions, plain sans explanation, and monospace measurements
- Cyan data signals with orange reserved for exceptions
- Native, inspectable disclosure behavior with no runtime JavaScript

## Colors

The palette feels like ink, instrument paper, and marked exceptions rather than software-brand decoration.

### Primary

- **Deep-Ocean Ink:** Primary text, the wordmark, and the strongest structural rules.
- **Evidence Blue:** Links, active disclosures, chart marks, and themed scrollbars that lead toward inspectable evidence.

### Secondary

- **Data Cyan:** Selection, the mast data line, and cool informational emphasis.

### Tertiary

- **Exception Orange:** Focus, the lead chart bar, and rare exception emphasis.

### Neutral

- **Paper White:** The page field and editorial reading surface.
- **Pure White:** The leaderboard and plot surface where dense evidence needs maximum clarity.
- **Harbor Muted:** Supporting labels, explanatory copy, and secondary measurements.
- **Chart Line:** Table rules, dividers, and quiet structural boundaries.

### Named Rules

**The Evidence Before Accent Rule.** Color directs attention to data, navigation, or exceptions; it never creates a decorative marketing layer ahead of results.

**The Orange Exception Rule.** Orange stays rare and signals focus or an exceptional state, so its scarcity preserves meaning.

## Typography

**Display Font:** Newsreader (with Georgia and serif fallbacks), self-hosted as a variable WOFF2 under the SIL Open Font License.

**Body Font:** Avenir Next (with Segoe UI and sans-serif fallbacks).

**Label/Mono Font:** The platform UI monospace stack for measurements and code only.

**Character:** Newsreader gives public-interest editorial authority to questions and section openings. Plain sans copy keeps methods direct, while tabular monospace makes protocol counts and ranks read like instrument output.

### Hierarchy

- **Display:** A tightly tracked, compact-line headline for the single first-viewport question, constrained to a narrow measure.
- **Headline:** Editorial section titles that reset the reading rhythm before each evidence class.
- **Body:** Plain explanatory prose with a readable maximum measure of roughly 70–72 characters.
- **Label:** Compact uppercase table and method labels with deliberate tracking.
- **Measurement:** Tabular monospace for ranks, counts, hashes, effort values, and code identifiers.

### Named Rules

**The Measurement Boundary Rule.** Monospace belongs only to measurements and code; prose, navigation, and status language remain sans-serif.

**The Chart Microcopy Exception.** In-SVG chart labels use a fixed pixel micro scale (10–13px) rather than the document rem ramp, because SVG text scales with the viewBox; this applies only inside the score chart figure.

## Layout

The page uses a centered shell capped at 1180px, with 20px desktop gutters and 12px mobile gutters. The mast occupies most of the first desktop viewport: a two-column question-and-protocol grid ends in a four-cell trust rail, then the leaderboard follows immediately.

Sections use an 88px vertical rhythm on wide screens and 64px below 760px. Editorial pairings use asymmetric grids: the hero favors the question, decisions reserve one third for the label, and methodology reserves a narrow evidence rail beside the explanation.

At 760px and below, the hero, decision, methodology, blocked-route rows, and footer become single-column flows; the trust rail becomes two columns. The leaderboard shows only the judgment columns — rank, model, balanced score, interval, and status — so the verdict reads without scrolling on desktop; every lane opens into a full-width evidence slip that carries its diagnostics, identity, and reproduce evidence.

**The Leaderboard-First Rule.** Result, qualification, and route status precede charts and methodology; explanation never delays access to the evidence.

## Elevation & Depth

The system uses no shadows. Depth comes from tonal contrast, ruled edges, and table headers. White evidence surfaces sit on paper through color and borders, not simulated elevation.

**The Flat Bulletin Rule.** Surfaces stay flat; hierarchy is earned with contrast, spacing, and rules rather than cards or shadows.

## Shapes

The form language is mostly square and typeset: sections, tables, plots, and route rows use straight ruled edges. Pill geometry is reserved for compact status markers. Small rounding appears only where it supports interaction, including focus outlines and scrollbar thumbs.

## Components

### Mast Navigation

- **Style:** An uppercase Needlefish wordmark anchors a sparse row of evidence routes on the paper mast.
- **State:** Links remain underlined by native text behavior and gain a thick orange focus outline for keyboard use.
- **Mobile:** Links wrap rather than collapsing into scripted navigation.

### Trust Rail

- **Style:** Four white cells separated by hairline rules pair a monospace fact with a small sans label.
- **Responsive:** The rail becomes a two-column grid on mobile.

### Leaderboard

- **Structure:** A white, horizontally scrollable table bounded by strong ink rules and quiet row dividers.
- **Priority:** Only rank, model, balanced score, interval, and status appear in the table; diagnostic metrics live in the lane's evidence slip.
- **Interaction:** The scroll region is keyboard-focusable, has a visible focus outline, and uses a thin evidence-blue scrollbar on a pale track.

### Evidence Disclosure

- **Style:** Native `details` and `summary` in each model cell toggle a full-width evidence slip (a companion table row shown via `:has(details[open])`) that exposes exact model, harness, route, run, hashes, and raw report links without runtime JavaScript.
- **State:** Open summaries turn evidence blue. Content uses a restrained 180ms reveal; reduced-motion preferences remove the animation.

### Score Chart

- **Form:** Horizontal bars on an honest 0–100 scale with 95% confidence whiskers, hairline row rules, and decile gridlines; each lane ends in a monospace `score ± half-width` value.
- **Grouping:** Qualified lanes come first under an uppercase group label, a dashed divider separates them from below-gate lanes, whose hollow muted-outline bars keep scores visible without a rank.
- **Color:** Evidence-blue bars mark qualified lanes, exception orange marks the top rank, and a small green dot marks the deployed lane; whiskers are ink on qualified rows and muted below the gate.
- **Gate reasons:** A below-gate lane carries the failed gate (for example `Tier-1 95.2%` or `noise 0.120`) in exception orange beside its effort label, so the hollow bar explains itself.
- **Responsive:** The figure hides below 760px, where the leaderboard table remains the canonical evidence.

### Status Marker

- **Shape:** A compact outlined pill.
- **Color:** Deployed uses restrained green, candidate uses a warm brown, and below-gate uses exception orange; the label always spells the status out.
- **Typography:** Bold, compact sans text; status is never communicated by color alone.

### Blocked Route List

- **Style:** Ruled rows expose name, exact model, provider, and reason as operational evidence rather than fake scores.
- **Responsive:** Columns collapse into one reading flow on mobile.

## Do's and Don'ts

### Do:

- **Do** lead with ranked, comparable results and show qualification status beside the score.
- **Do** preserve direct access to raw reports, hashes, route details, and blocked reasons.
- **Do** keep native keyboard behavior, visible focus, responsive table scrolling, and reduced-motion handling.
- **Do** use the self-hosted Newsreader asset with its OFL provenance intact.

### Don't:

- **Don't** insert marketing cards, feature grids, or decorative claims before the leaderboard.
- **Don't** turn unavailable routes or invalid reports into zero scores.
- **Don't** use monospace as a general aesthetic font or orange as ambient decoration.
- **Don't** hide dense evidence behind runtime JavaScript or replace the semantic table with visual divs.
