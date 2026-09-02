# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain static HTML and CSS under `docs/`, suitable for GitHub Pages and a later custom domain.

## Users

The primary audience is the general public. A visitor should understand what Needlefish tests, which review lane performed best, and why the result is trustworthy without knowing the evaluation internals.

## Product Purpose

Needlefish reviews pull requests for real defects while suppressing style noise. The public benchmark explains and substantiates that claim with reproducible results.

## Positioning

Needlefish combines agentic repository inspection with an adversarial critic and derives verdicts deterministically from validated findings.

## Capabilities and Constraints

- Publish only complete, comparable, anti-cheat-guarded evaluation reports as ranked results.
- Identify model, runner, provider/subscription route, and effort separately.
- Treat unavailable models and provider failures as blocked or operational outcomes, never as zero model scores.
- Keep raw reports and methodology accessible.
- Do not deploy or configure a custom domain until the user supplies one.

## Brand Commitments

Use the Needlefish name and the existing `assets/banner.png`. Keep claims terse, factual, and evidence-backed.

## Evidence on Hand

The repository contains the evaluation harness, raw reports under `eval/results/`, and the chronological methodology record in `eval/RESULTS.md`.

## Product Principles

- Lead with the result, then explain the method.
- Make trust boundaries visible.
- Separate model quality from harness and provider reliability.
- Prefer raw evidence over marketing claims.

## Accessibility & Inclusion

Use semantic HTML, keyboard-accessible disclosure controls, visible focus, sufficient contrast, and responsive tables.
