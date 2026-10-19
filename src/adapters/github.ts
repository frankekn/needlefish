import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { reviewExitCode } from "../core/verdict.js";
import { isDocsOnlyFastPath, review } from "../core/review.js";
import { RunnerOperationalError } from "../shared/codex.js";
import {
	priorFateParts,
	renderMarkdown,
	type PriorFate,
	type PriorFateCounts,
} from "../shared/render.js";
import { changedFiles, ghText, git, makeBundle, prDiffFromShas, readAgentsAt, reviewDiff } from "../shared/repo.js";
import { normalizeBodyList, OWN_POST_FINDING_MARKER } from "../shared/normalize.js";
import { runText, runTextAsync } from "../shared/process.js";
import { envFlagOn } from "../shared/env.js";
import { resolveConnectionOptions } from "../shared/connections.js";
import {
	registerTerminationFinalizer,
	type Termination,
} from "../shared/temp-lifecycle.js";
import {
	credentialValuesFromEnv,
	screenPayload,
	screenText,
	WITHHELD_MESSAGE,
	type Screened,
} from "../shared/outbound-screen.js";
import {
	formatSuggestionComment,
	GH_BODY_CHAR_LIMIT,
} from "./github-suggestions.js";
import type { Finding, ReviewResult, Verdict } from "../shared/schema.js";
import type { RunnerOptions } from "../shared/runner.js";

type JsonRecord = Record<string, unknown>;

function isRecord(raw: unknown): raw is JsonRecord {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function parseGhJson(out: string): unknown {
	if (!out) return {};
	try {
		return JSON.parse(out);
	} catch (error) {
		throw new Error("GitHub returned invalid JSON", { cause: error });
	}
}

function ghJson(args: readonly string[], input?: string): unknown {
	return parseGhJson(ghText(args, undefined, input));
}

// gh for the termination finalizer: off the event loop, cut off at the
// termination deadline, killed with the process, and without ghPost's 5xx
// retry schedule, which the deadline would not cover.
async function ghJsonWhileTerminating(
	termination: Termination,
	args: readonly string[],
	input?: string,
): Promise<unknown> {
	const out = await runTextAsync("gh", args, {
		input,
		timeoutMs: Math.max(1, termination.deadlineMs - Date.now()),
		abortSignal: termination.cancelled,
	});
	return parseGhJson(out);
}

// Posting calls only: a transient GitHub 5xx must not turn a completed
// review into a red "review failed" check. Reads and dedupe probes
// (findPreviousReview, postReviewSkipReason, authenticatedLogin, the entry
// PR fetch) stay on ghJson — single attempt — since retrying them buys
// nothing and slows the stale-head gate. Never wrap the model runner.
// Retry is limited to idempotent writes (-X PUT / -X PATCH): a 502 can arrive
// after GitHub already stored a POST body, and retrying a POST would then
// double-post the review, comment, or label.
const GH_POST_ATTEMPTS = 3;
const GH_POST_RETRY_BASE_MS = 250;

function ghPostRetryBaseMs(): number {
	const raw = process.env.NEEDLEFISH_GH_POST_RETRY_MS;
	if (raw === undefined || raw === "") return GH_POST_RETRY_BASE_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(
			"NEEDLEFISH_GH_POST_RETRY_MS requires a non-negative integer",
		);
	}
	return parsed;
}

function isTransientGh5xx(error: unknown): boolean {
	return (
		error instanceof Error &&
		(/HTTP 5\d{2}\b/.test(error.message) ||
			/server error/i.test(error.message))
	);
}

// gh args carry the verb as "-X <METHOD>"; only PUT/PATCH are safe to repeat.
function isIdempotentWrite(args: readonly string[]): boolean {
	const i = args.indexOf("-X");
	const method = i >= 0 ? args[i + 1] : "";
	return method === "PUT" || method === "PATCH";
}

function outboundText(text: string, screened: Screened): string {
	switch (screened.kind) {
		case "clean":
			return text;
		case "redacted":
			return screened.text;
		case "withheld":
			throw new Error(WITHHELD_MESSAGE);
	}
}

// Actions logs are readable by anyone who can read the repository.
function stdoutSummary(summary: string): string {
	const screened = screenText(summary, credentialValuesFromEnv(process.env));
	return screened.kind === "withheld"
		? `${WITHHELD_MESSAGE}\n`
		: outboundText(summary, screened);
}

// Every GitHub write's payload passes here (ghPost and the termination
// finalizer), so screening here covers every payload a PR reader can see.
function screenedInput(rawInput: string): string {
	return outboundText(
		rawInput,
		screenPayload(rawInput, credentialValuesFromEnv(process.env)),
	);
}

function ghPost(args: readonly string[], rawInput?: string): unknown {
	const input = rawInput === undefined ? undefined : screenedInput(rawInput);
	if (!isIdempotentWrite(args)) return ghJson(args, input);
	for (let attempt = 1; ; attempt++) {
		try {
			return ghJson(args, input);
		} catch (err) {
			if (attempt >= GH_POST_ATTEMPTS || !isTransientGh5xx(err)) throw err;
			const delay = ghPostRetryBaseMs() * attempt;
			const detail = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`needlefish: GitHub write failed transiently (attempt ${attempt}/${GH_POST_ATTEMPTS}); retrying in ${delay}ms: ${detail}\n`,
			);
			if (delay > 0) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
			}
		}
	}
}

function stringField(raw: JsonRecord, field: string): string {
	const value = raw[field];
	return typeof value === "string" ? value : "";
}

// Same merge-base and changed-file list the bundle uses. Any git failure
// counts as not docs-only, so the caller keeps its credential error.
function docsOnlyHead(repoPath: string, baseSha: string, headSha: string): boolean {
	if (!baseSha) return false;
	try {
		return isDocsOnlyFastPath({ changedFiles: changedFiles(repoPath, git(["merge-base", baseSha, headSha], repoPath), headSha) });
	} catch {
		return false;
	}
}

function nestedString(
	raw: JsonRecord,
	field: string,
	nestedField: string,
): string {
	const value = raw[field];
	return isRecord(value) ? stringField(value, nestedField) : "";
}

const VERDICT_CONCLUSION: Record<Verdict, "success" | "failure"> = {
	pass: "success",
	changes_requested: "failure",
	needs_human: "failure",
};

export const VERDICT_LABELS: Record<Verdict, string> = {
	pass: "needlefish:pass",
	changes_requested: "needlefish:changes-requested",
	needs_human: "needlefish:needs-human",
};

const VERDICT_LABEL_COLORS: Record<Verdict, string> = {
	pass: "0e8a16",
	changes_requested: "d93f0b",
	needs_human: "fbca04",
};

type GhFn = (args: readonly string[], input?: string) => unknown;

function is404(error: unknown): boolean {
	return error instanceof Error && /(?:\b404\b|not found)/i.test(error.message);
}

export function applyVerdictLabel(
	repo: string,
	prNumber: number,
	verdict: Verdict,
	ghFn: GhFn = (args, input) => ghPost(args, input),
): Promise<void> {
	const currentLabel = VERDICT_LABELS[verdict];
	try {
		try {
			ghFn(["api", `repos/${repo}/labels/${currentLabel}`]);
		} catch (error) {
			if (!is404(error)) throw error;
			ghFn([
				"api",
				"-X",
				"POST",
				`repos/${repo}/labels`,
				"-f",
				`name=${currentLabel}`,
				"-f",
				`color=${VERDICT_LABEL_COLORS[verdict]}`,
				"-f",
				"description=Needlefish review verdict",
			]);
		}

		for (const label of Object.values(VERDICT_LABELS)) {
			if (label === currentLabel) continue;
			try {
				ghFn([
					"api",
					"-X",
					"DELETE",
					`repos/${repo}/issues/${prNumber}/labels/${label}`,
				]);
			} catch (error) {
				if (!is404(error)) throw error;
			}
		}

		ghFn([
			"api",
			"-X",
			"POST",
			`repos/${repo}/issues/${prNumber}/labels`,
			"-f",
			`labels[]=${currentLabel}`,
		]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(
			`needlefish: could not apply verdict label: ${message}\n`,
		);
	}
	return Promise.resolve();
}

// Git C-quoting (quote.c unquote_c_style): surrounding double quotes,
// named escapes \a \b \f \n \r \t \v \\ \", and 3-digit octal \NNN.
// Octal values are bytes of the UTF-8 path, not independent code points.
export function unquoteGitCStyle(quoted: string): string | null {
	const src = Buffer.from(quoted, "utf8");
	if (src.length < 2 || src[0] !== 0x22) return null;
	const out: number[] = [];
	let i = 1;
	while (i < src.length) {
		const b = src[i++];
		if (b === 0x22) return Buffer.from(out).toString("utf8");
		if (b !== 0x5c) {
			out.push(b);
			continue;
		}
		if (i >= src.length) return null;
		const esc = src[i++];
		switch (esc) {
			case 0x61:
				out.push(0x07);
				break;
			case 0x62:
				out.push(0x08);
				break;
			case 0x66:
				out.push(0x0c);
				break;
			case 0x6e:
				out.push(0x0a);
				break;
			case 0x72:
				out.push(0x0d);
				break;
			case 0x74:
				out.push(0x09);
				break;
			case 0x76:
				out.push(0x0b);
				break;
			case 0x5c:
			case 0x22:
				out.push(esc);
				break;
			case 0x30:
			case 0x31:
			case 0x32:
			case 0x33: {
				if (i + 1 >= src.length) return null;
				const d2 = src[i];
				const d3 = src[i + 1];
				if (d2 < 0x30 || d2 > 0x37 || d3 < 0x30 || d3 > 0x37) return null;
				i += 2;
				out.push(((esc - 0x30) << 6) | ((d2 - 0x30) << 3) | (d3 - 0x30));
				break;
			}
			default:
				return null;
		}
	}
	return null;
}

function pathFromDiffHeaderRest(rest: string): string | null {
	if (rest.startsWith('"')) return unquoteGitCStyle(rest);
	const tab = rest.indexOf("\t");
	return tab === -1 ? rest : rest.slice(0, tab);
}

function pathFromFileHeader(line: string, side: "a/" | "b/"): string | null {
	const decoded = pathFromDiffHeaderRest(line.slice(4));
	if (decoded === null || decoded === "/dev/null") return null;
	if (!decoded.startsWith(side)) return null;
	const file = decoded.slice(2);
	return file === "" ? null : file;
}

// Parse a unified diff into head-side (new) line ranges per file path.
// `+++` paths follow git quoting: unquoted `b/<path>`, or C-quoted
// `"b/<path>"` (the `b/` prefix sits inside the quotes). A tab after the
// name is a GNU-patch terminator / timestamp separator, not part of the path.
// Hunk headers `@@ -a,b +c,d @@` yield [c, c+d-1]; omitted counts default
// to 1. Deleted files (`+++ /dev/null`) are skipped. Once a hunk header is
// seen, the parser consumes exactly the declared line counts before reading
// another header, so a hunk body line cannot masquerade as a file header:
// an added line whose content starts with `++ ` (patch line `+++ b/x`)
// stays inside the hunk instead of switching the current file.
export function headLinesInPatch(
	patch: string,
): Map<string, Array<[number, number]>> {
	const ranges = new Map<string, Array<[number, number]>>();
	let file: string | null = null;
	let hunk: { old: number; new: number } | null = null;
	for (const raw of patch.split("\n")) {
		if (hunk) {
			if (raw.startsWith("+")) hunk.new--;
			else if (raw.startsWith("-")) hunk.old--;
			else if (!raw.startsWith("\\")) {
				hunk.old--;
				hunk.new--;
			}
			if (hunk.old <= 0 && hunk.new <= 0) hunk = null;
			continue;
		}
		if (raw.startsWith("+++ ")) {
			file = pathFromFileHeader(raw, "b/");
			if (file && !ranges.has(file)) ranges.set(file, []);
			continue;
		}
		if (file && raw.startsWith("@@")) {
			const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
			if (h) {
				const c = Number(h[2]);
				const d = h[3] === undefined ? 1 : Number(h[3]);
				if (d > 0) ranges.get(file)!.push([c, c + d - 1]);
				hunk = { old: h[1] === undefined ? 1 : Number(h[1]), new: d };
			}
		}
	}
	return ranges;
}

export function anchorableIn(
	ranges: Map<string, Array<[number, number]>>,
	file: string,
	line: number,
): boolean {
	const rs = ranges.get(file);
	if (!rs) return false;
	return rs.some(([start, end]) => line >= start && line <= end);
}

// --- Cross-round review state ---
// Title normalizer mirrors dedup() in src/core/review.ts (same idea, duplicated
// locally to keep the adapter layer free of core imports).
export function normalizeTitle(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
}

export interface FindingKey {
	readonly file: string;
	readonly lineStart: number;
	readonly category: string;
	readonly title: string;
}

interface DeliveryReceipt {
	readonly checkId: number;
	readonly appId: number;
	readonly roundId: string;
	readonly runId: string;
}

export type RoundState = {
	readonly headSha: string;
	readonly findings: readonly FindingKey[];
} & ({ readonly v: 1 } | { readonly v: 2; readonly delivery: DeliveryReceipt });

interface CheckRound {
	readonly v: 2;
	readonly prNumber: number;
	readonly roundId: string;
	readonly runId: string;
	// Only adapter rounds write it; workflow receipts (author skip, caller retry) omit it.
	readonly recheck?: boolean;
}

function parseCheckRound(raw: unknown): CheckRound | null {
	if (typeof raw !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || parsed.v !== 2 || typeof parsed.prNumber !== "number" || !Number.isSafeInteger(parsed.prNumber) || parsed.prNumber < 1 || typeof parsed.roundId !== "string" ||
		!parsed.roundId || typeof parsed.runId !== "string" ||
		(parsed.recheck !== undefined && typeof parsed.recheck !== "boolean")) return null;
	return { v: 2, prNumber: parsed.prNumber, roundId: parsed.roundId, runId: parsed.runId, ...(parsed.recheck !== undefined ? { recheck: parsed.recheck } : {}) };
}

function findingKey(f: Finding): FindingKey {
	return {
		file: f.file,
		lineStart: f.lineStart,
		category: f.category,
		title: normalizeTitle(f.title),
	};
}

export function renderState(
	headSha: string,
	findings: readonly Finding[],
	delivery: DeliveryReceipt,
): string {
	return serializeState({ v: 2, headSha, findings: findings.map(findingKey), delivery });
}

function serializeState(state: RoundState): string {
	// Escape title text so it cannot terminate the HTML comment.
	const payload = JSON.stringify(state).replace(/>/g, "\\u003e");
	return `<!-- needlefish-state: ${payload} -->`;
}

const STATE_PREFIX = "<!-- needlefish-state:";

export function parseState(body: string): RoundState | null {
	const start = body.lastIndexOf(STATE_PREFIX);
	if (start < 0) return null;
	const jsonStart = start + STATE_PREFIX.length;
	const end = body.indexOf("-->", jsonStart);
	if (end < 0 || body.slice(end + 3).trim() !== "") return null;
	let raw: unknown;
	try {
		raw = JSON.parse(body.slice(jsonStart, end));
	} catch {
		return null;
	}
	if (!isRecord(raw)) return null;
	if (raw.v !== 1 && raw.v !== 2) return null;
	const headSha = raw.headSha;
	if (typeof headSha !== "string") return null;
	const findingsRaw = raw.findings;
	if (!Array.isArray(findingsRaw)) return null;
	const keys: FindingKey[] = [];
	for (const item of findingsRaw) {
		if (!isRecord(item)) return null;
		const { file, lineStart, category, title } = item;
		if (
			typeof file !== "string" ||
			typeof lineStart !== "number" ||
			typeof category !== "string" ||
			typeof title !== "string"
		) {
			return null;
		}
		keys.push({ file, lineStart, category, title });
	}
	if (raw.v === 1) return { v: 1, headSha, findings: keys };
	const delivery = raw.delivery;
	if (!isRecord(delivery) || typeof delivery.checkId !== "number" || !Number.isSafeInteger(delivery.checkId) || delivery.checkId < 1 ||
		typeof delivery.appId !== "number" || !Number.isSafeInteger(delivery.appId) || delivery.appId < 1 ||
		typeof delivery.roundId !== "string" || !delivery.roundId || typeof delivery.runId !== "string") return null;
	return { v: 2, headSha, findings: keys, delivery: {
		checkId: delivery.checkId, appId: delivery.appId, roundId: delivery.roundId, runId: delivery.runId,
	} };
}

// GitHub rejects a review or comment body over 65,536 characters with a 422
// (#215, same class as the closed #179 on the check-summary endpoint). Unlike
// the check-summary cap in checkCompletion, this limit counts characters, not
// UTF-8 bytes. Every outbound body routes through screenAndCapOutboundBody at
// the post site (postReview, updateReviewBody, postIssueComment). The limit
// (GH_BODY_CHAR_LIMIT) lives in github-suggestions.ts, which drops a
// suggestion block that would not fit rather than let the cut open its fence.

// No claim of a full copy anywhere: the check summary omits inline findings'
// evidence/fix and caps itself, so text cut from an inline comment exists
// nowhere else (#215 staff review). The dropped count sits inside the notice,
// and the notice length feeds the cut budget; dropped only grows as the
// notice grows, so the digit width converges after a few rounds.
function truncatedNotice(dropped: number): string {
	return `Review body shortened to fit GitHub's size limit; ${dropped} characters were dropped.\n\n`;
}

// The state marker is the dedupe receipt and renderMarkdown appends it at the
// very end — exactly where a naive truncation would cut it, turning every
// later trigger into a full model re-review (see persistStateMarker). Own-post
// markers (normalize.ts OWN_POST_MARKERS) ride the last non-empty line so a
// Needlefish post is recognized on the way back in; a truncated inline
// finding that lost it would be fed to the model as human discussion. So both
// are pulled out before the cut and re-appended whole, notice first so it
// stays visible even when the retained Markdown holds unclosed constructs.
export function capOutboundBody(body: string): string {
	if (body.length <= GH_BODY_CHAR_LIMIT) return body;
	// Scan for the state marker exactly like parseState, so an extracted
	// marker parses back exactly as the next run will read the posted body.
	const markerStart = body.lastIndexOf(STATE_PREFIX);
	const markerEnd =
		markerStart < 0
			? -1
			: body.indexOf("-->", markerStart + STATE_PREFIX.length);
	// Only the body's trailing marker is the delivery marker. A finding that
	// quotes a valid marker mid-text is model prose: treating the quote as the
	// receipt would swallow the evidence, fix, and own-post trailer after it
	// (#215 staff review).
	const state =
		markerEnd >= 0 && body.slice(markerEnd + 3).trim() === ""
			? parseState(body.slice(markerStart, markerEnd + 3))
			: null;
	let content = body;
	let suffix = "";
	if (state) {
		content = body.slice(0, markerStart);
	} else if (body.endsWith(OWN_POST_FINDING_MARKER)) {
		// Truncation keeps the marker as the last line so a truncated inline
		// finding is still recognized as Needlefish's own.
		content = body
			.slice(0, -OWN_POST_FINDING_MARKER.length)
			.replace(/\n+$/, "");
		suffix = `\n\n${OWN_POST_FINDING_MARKER}`;
	}
	let notice = truncatedNotice(1);
	for (let round = 0; ; round++) {
		if (state) {
			suffix = `\n${fitStateMarker(
				state,
				GH_BODY_CHAR_LIMIT - notice.length - 2,
			)}\n`;
		}
		const budget = Math.max(
			0,
			GH_BODY_CHAR_LIMIT - notice.length - suffix.length,
		);
		let prefix = content.length > budget ? content.slice(0, budget) : content;
		const last = prefix.charCodeAt(prefix.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
		const next = truncatedNotice(
			Math.max(0, body.length - prefix.length - suffix.length),
		);
		if (next.length === notice.length) return next + prefix + suffix;
		notice = next;
	}
}

// Screen before cutting: a credential straddling the cut loses its tail, then
// matches neither the known value nor a token shape, and its bare prefix is
// posted (#215 staff review: a 24-char env credential leaked its first 23
// chars). Redaction only shrinks text, so capping after screening still fits,
// and withheld propagates exactly as screenedInput does today — that final
// gate stays, covering everything else in the payload.
function screenAndCapOutboundBody(body: string): string {
	return capOutboundBody(
		outboundText(body, screenText(body, credentialValuesFromEnv(process.env))),
	);
}

// The marker carries one key per finding, so a large enough findings list can
// push the marker itself past the limit. Keep the longest finding-key prefix
// that fits: the headSha match still dedupes the same head, and dropped keys
// only cost the next round's still-open accounting.
function fitStateMarker(state: RoundState, budget: number): string {
	let lo = 0;
	let hi = state.findings.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (
			serializeState({ ...state, findings: state.findings.slice(0, mid) }).length <=
			budget
		)
			lo = mid;
		else hi = mid - 1;
	}
	return serializeState({ ...state, findings: state.findings.slice(0, lo) });
}

export interface MatchResult {
	readonly fresh: readonly Finding[];
	readonly open: readonly Finding[];
	readonly unmatched: readonly FindingKey[];
}

const LINE_DRIFT = 10;

function nearSameSpot(c: Finding, prev: FindingKey): boolean {
	return (
		c.file === prev.file &&
		c.category === prev.category &&
		Math.abs(c.lineStart - prev.lineStart) <= LINE_DRIFT
	);
}

export function matchFindings(
	prevKeys: readonly FindingKey[],
	curr: readonly Finding[],
): MatchResult {
	const matched = new Set<number>();
	const unmatched: FindingKey[] = [];
	for (const prev of prevKeys) {
		const hit = curr.findIndex(
			(c, i) =>
				!matched.has(i) &&
				nearSameSpot(c, prev) &&
				normalizeTitle(c.title) === prev.title,
		);
		if (hit >= 0) matched.add(hit);
		else unmatched.push(prev);
	}
	const fresh: Finding[] = [];
	const open: Finding[] = [];
	curr.forEach((f, i) => {
		(matched.has(i) ? open : fresh).push(f);
	});
	return { fresh, open, unmatched };
}

const WHOLE_FILE: [number, number] = [1, Number.POSITIVE_INFINITY];

// Old-side (previous head) line ranges per path from `git diff -U0`. A
// zero-length hunk `-a,0` sits between old lines a and a+1, so it touches
// both. A deleted path is touched everywhere; with --no-renames a rename
// arrives as a deletion of the old path. File headers are read only between
// `diff --git` and the first hunk, so a removed line starting "-- " is not
// mistaken for a `---` header.
export function oldSideTouches(
	diff: string,
): Map<string, Array<[number, number]>> {
	const touches = new Map<string, Array<[number, number]>>();
	let file: string | null = null;
	let inHeader = false;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("diff --git ")) {
			inHeader = true;
			file = null;
			continue;
		}
		if (inHeader && raw.startsWith("--- ")) {
			file = pathFromFileHeader(raw, "a/");
			if (file && !touches.has(file)) touches.set(file, []);
			continue;
		}
		if (inHeader && raw.startsWith("+++ ")) {
			if (file && pathFromDiffHeaderRest(raw.slice(4)) === "/dev/null") {
				touches.get(file)!.push(WHOLE_FILE);
			}
			continue;
		}
		if (raw.startsWith("@@")) {
			inHeader = false;
			const h = /^@@ -(\d+)(?:,(\d+))? \+/.exec(raw);
			if (file && h) {
				const a = Number(h[1]);
				const b = h[2] === undefined ? 1 : Number(h[2]);
				touches.get(file)!.push(b === 0 ? [a, a + 1] : [a, a + b - 1]);
			}
		}
	}
	return touches;
}

export function classifyUnmatched(
	unmatched: readonly FindingKey[],
	touches: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>> | null,
): PriorFateCounts {
	const counts: Record<PriorFate, number> = {
		code_changed: 0,
		code_unchanged: 0,
		undetermined: 0,
	};
	for (const key of unmatched) {
		if (touches === null) {
			counts.undetermined++;
			continue;
		}
		const lo = key.lineStart - LINE_DRIFT;
		const hi = key.lineStart + LINE_DRIFT;
		const changed = (touches.get(key.file) ?? []).some(
			([start, end]) => start <= hi && end >= lo,
		);
		counts[changed ? "code_changed" : "code_unchanged"]++;
	}
	return counts;
}

// null means the previous head is not available locally, even after one
// fetch; every unmatched key is then undetermined rather than guessed.
export function touchesSincePrevHead(
	repoPath: string,
	prevHead: string,
	headSha: string,
): Map<string, Array<[number, number]>> | null {
	if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(prevHead)) return null;
	try {
		try {
			git(["cat-file", "-e", `${prevHead}^{commit}`], repoPath);
		} catch {
			runText("git", ["fetch", "--no-tags", "origin", prevHead], {
				cwd: repoPath,
				timeoutMs: 120000,
			});
		}
		return oldSideTouches(
			git(
				[...reviewDiff(repoPath), "--no-color", "--no-renames", "-U0", prevHead, headSha],
				repoPath,
				{ preserveOutput: true },
			),
		);
	} catch {
		return null;
	}
}

type InlineComment = {
	readonly path: string;
	readonly line: number;
	readonly side: "RIGHT";
	readonly start_line?: number;
	readonly start_side?: "RIGHT";
	readonly body: string;
};

type SuggestionContext = {
	readonly repoPath: string;
	readonly headSha: string;
};

function headLineCount(
	repoPath: string,
	headSha: string,
	file: string,
): number | null {
	try {
		const content = git(["show", `${headSha}:${file}`], repoPath, {
			preserveOutput: true,
		});
		if (content === "") return 0;
		return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n")
			.length;
	} catch (err) {
		if (err instanceof Error) return null;
		throw err;
	}
}

function buildInlineComments(
	result: ReviewResult,
	patch: string,
	ctx: SuggestionContext,
): { comments: InlineComment[]; inlined: Set<Finding> } {
	const ranges = headLinesInPatch(patch);
	const anchorable = result.findings.filter(
		(f) => f.file !== "" && anchorableIn(ranges, f.file, f.lineStart),
	);
	const selected =
		anchorable.length > 20
			? anchorable.filter(
					(f) =>
						f.severity === "P0" || f.severity === "P1" || f.severity === "P2",
				)
			: anchorable;
	const inlined = new Set<Finding>(selected);
	const comments: InlineComment[] = selected.map((f) => {
		const formatted = formatSuggestionComment(f, {
			ranges,
			headLineCount: () => headLineCount(ctx.repoPath, ctx.headSha, f.file),
		});
		return {
			path: f.file,
			line: formatted.line,
			side: "RIGHT",
			...(formatted.startLine !== undefined
				? { start_line: formatted.startLine, start_side: "RIGHT" as const }
				: {}),
			body: formatted.body,
		};
	});
	return { comments, inlined };
}

function postReview(
	repo: string,
	prNumber: number,
	headSha: string,
	body: string,
	comments: readonly InlineComment[],
	appBotLogin: string | null,
): number | null {
	const payload = JSON.stringify({
		commit_id: headSha,
		body: screenAndCapOutboundBody(body),
		event: "COMMENT",
		// Inline comment bodies are model text on the same 422 endpoint.
		comments: comments.map((comment) => ({
			...comment,
			body: screenAndCapOutboundBody(comment.body),
		})),
	});

	const args = ["api", "-X", "POST", `repos/${repo}/pulls/${prNumber}/reviews`, "--input", "-"];
	let before: Set<unknown>;
	try { before = new Set(readReviews(repo, prNumber).map((item) => item.id)); }
	catch {
		const created = ghPost(args, payload);
		return isRecord(created) && typeof created.id === "number" ? created.id : null;
	}
	const selfLogin = authenticatedLogin();
	const created = reconciledPost(
		args,
		payload,
		() => {
			const matching = readReviews(repo, prNumber).filter((item) => !before.has(item.id) &&
				item.commit_id === headSha && item.body === screenAndCapOutboundBody(body));
			const candidate = matching.find((item) => isTrustedStateAuthor(item, selfLogin, appBotLogin));
			if (!candidate) {
				if (matching.length > 0) throw new Error("Cannot verify ownership of the stored review; not retrying its POST");
				return null;
			}
			if (comments.length > 0) {
				const raw = ghJson(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${prNumber}/reviews/${String(candidate.id)}/comments`]);
				if (!Array.isArray(raw)) throw new Error("Could not verify stored inline comments");
				const stored = raw.flat(1).filter(isRecord);
				if (stored.length !== comments.length || !comments.every((comment) => stored.some((item) =>
					item.path === comment.path && item.line === comment.line && (item.start_line ?? undefined) === comment.start_line &&
					item.side === comment.side &&
					item.body === screenAndCapOutboundBody(comment.body) && isTrustedStateAuthor(item, selfLogin, appBotLogin)))) {
					throw new Error("Review was stored but inline delivery is incomplete; rerun the review");
				}
			}
			return candidate;
		},
	);
	// The id is needed later to append the dedupe state marker once delivery
	// has completed. A response without an id is tolerated: the body is
	// already posted, only the marker write is skipped (see persistStateMarker).
	return isRecord(created) && typeof created.id === "number" ? created.id : null;
}

// Marker writes fail soft because the review and verdict already reached GitHub.
// Reconciliation and same-head skipping require this receipt and its completed check.
function persistStateMarker(
	repo: string,
	prNumber: number,
	reviewId: number | null,
	body: string,
): void {
	if (reviewId === null) {
		process.stderr.write(
			"needlefish: review posted without a state marker (GitHub returned no review id); the next run will re-review this head.\n",
		);
		return;
	}
	try {
		updateReviewBody(repo, prNumber, reviewId, body);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(
			`needlefish: could not persist the review state marker: ${msg}; the next run will re-review this head.\n`,
		);
	}
}

function updateReviewBody(
	repo: string,
	prNumber: number,
	reviewId: number,
	body: string,
): void {
	ghPost(
		[
			"api",
			"-X",
			"PUT",
			`repos/${repo}/pulls/${prNumber}/reviews/${reviewId}`,
			"--input",
			"-",
		],
		JSON.stringify({ body: screenAndCapOutboundBody(body) }),
	);
}

export function findPreviousReview(
	repo: string,
	prNumber: number,
	expectedAppId: number | null = null,
): { id: number; state: RoundState } | null {
	const reviews = readReviews(repo, prNumber);
	// TRUST BOUNDARY. What this function returns decides two things in
	// runGithub: (a) the same-head dedupe, which returns *before* the model
	// run, the review post and the check-run post; and (b) the review id whose
	// body the next round is PUT onto. Anyone can submit a review on a public
	// PR, so a marker accepted from an author we have not authenticated is a
	// silent review-suppression bypass — needlefish reports nothing and the PR
	// looks unreviewed-but-fine. Authorization therefore runs on identity
	// GitHub asserts (isTrustedStateAuthor), never on the shape of a login the
	// author picked. An untrusted marker is skipped, not fatal: the scan keeps
	// walking to older reviews. authenticatedLogin() is called once per run,
	// not per review; when it fails it returns "" and trust narrows to verified
	// bot identities, which can cause an extra review but never a suppressed
	// one — the safe direction here, unlike the cosmetic cleanup path.
	const selfLogin = authenticatedLogin();
	for (let i = reviews.length - 1; i >= 0; i--) {
		const item = reviews[i];
		if (!isRecord(item)) continue;
		const state = parseState(stringField(item, "body"));
		if (!state) continue;
		const id = item.id;
		if (typeof id !== "number") continue;
		if (expectedAppId !== null) {
			if (state.v !== 2 || state.delivery.appId !== expectedAppId ||
				nestedString(item, "user", "type") !== "Bot") continue;
			const checks = readCheckRuns(repo, state.headSha);
			if (completedCheckVerdict(state, checks, prNumber) === null) continue;
			const check = checks.find((check) => check.id === state.delivery.checkId);
			if (!isTrustedStateAuthor(item, selfLogin, customAppBotLogin(check?.app, expectedAppId))) continue;
		} else if (!isTrustedStateAuthor(item, selfLogin)) continue;
		return { id, state };
	}
	return null;
}

// Explain trusts prior findings only from a delivered round: a v2 receipt whose
// owned check completed. Legacy and undelivered markers give it no context.
export function findDeliveredReview(repo: string, prNumber: number, expectedAppId: number | null): RoundState | null {
	const previous = findPreviousReview(repo, prNumber, expectedAppId);
	if (previous?.state.v !== 2) return null;
	return deliveredVerdict(previous.state, readCheckRuns(repo, previous.state.headSha), prNumber, expectedAppId) !== null ? previous.state : null;
}

function ownedCheckAppId(app: unknown, expectedAppId: number | null): number | null {
	if (!isRecord(app) || typeof app.id !== "number" || !Number.isSafeInteger(app.id) || app.id <= 0) return null;
	if (expectedAppId === null && app.slug !== "github-actions") return null;
	if (expectedAppId !== null && app.id !== expectedAppId) return null;
	return app.id;
}

function customAppBotLogin(app: unknown, expectedAppId: number | null): string | null {
	if (expectedAppId === null) return null;
	if (ownedCheckAppId(app, expectedAppId) === null || !isRecord(app)) return "";
	const slug = stringField(app, "slug");
	return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) ? `${slug}[bot]` : "";
}

// S5a: create the check as in_progress BEFORE any model work so a PR always
// shows whether a review is running on its latest head. All completions update
// this same check by id. An unknown id cannot authorize a completion.
function createPendingCheck(repo: string, headSha: string, round: CheckRound, expectedAppId: number | null): { id: number; appId: number; botLogin: string | null } | null {
	try {
		const created = reconciledPost(
			["api", "-X", "POST", `repos/${repo}/check-runs`, "--input", "-"],
			JSON.stringify({
				name: "Needlefish", head_sha: headSha, status: "in_progress",
				external_id: JSON.stringify(round),
				details_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
					? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined,
			}),
			() => {
				const matching = readCheckRuns(repo, headSha).filter((run) => run.head_sha === headSha && run.external_id === JSON.stringify(round));
				const owned = matching.filter((run) => run.name === "Needlefish" && ownedCheckAppId(run.app, expectedAppId) !== null);
				if (owned.length === 1 && matching.length === 1) return owned[0];
				if (matching.length > 0) throw new Error("Cannot verify ownership of the stored check; not retrying its POST");
				return null;
			},
		);
		const appId = isRecord(created) ? ownedCheckAppId(created.app, expectedAppId) : null;
		if (isRecord(created) && typeof created.id === "number" && Number.isSafeInteger(created.id) && created.id > 0 && appId !== null) {
			return { id: created.id, appId, botLogin: customAppBotLogin(created.app, expectedAppId) };
		}
		throw new Error("GitHub returned no owned check id/app identity");
	} catch (err) {
		const em = err instanceof Error ? err.message : String(err);
		process.stderr.write(`needlefish: could not create pending check: ${em}\n`);
		return null;
	}
}

type GhWrite = { readonly args: readonly string[]; readonly input: string };

function postCheck(
	repo: string,
	headSha: string,
	result: ReviewResult | null,
	conclusion: "success" | "failure" | "neutral",
	title: string,
	summary: string,
	checkId?: number | null,
): void {
	const write = checkCompletion(repo, headSha, result, conclusion, title, summary, checkId);
	ghPost(write.args, write.input);
}

function checkCompletion(
	repo: string,
	headSha: string,
	result: ReviewResult | null,
	conclusion: "success" | "failure" | "neutral",
	title: string,
	summary: string,
	checkId?: number | null,
): GhWrite {
	// Checks cap Markdown by UTF-8 bytes, unlike review bodies. The full
	// review has already been posted; keep its verdict and evidence there.
	if (Buffer.byteLength(summary, "utf8") > 65_535) {
		const reviewUrl = result?.prNumber
			? `https://github.com/${repo}/pull/${result.prNumber}`
			: `https://github.com/${repo}/commit/${headSha}`;
		const notice = `Check summary shortened to fit GitHub's limit. [Full review](${reviewUrl}).\n\n`;
		const budget = 65_535 - Buffer.byteLength(notice, "utf8");
		let bytes = 0;
		let prefix = "";
		for (const character of summary) {
			bytes += Buffer.byteLength(character, "utf8");
			if (bytes > budget) break;
			prefix += character;
		}
		summary = notice + prefix;
	}
	if (typeof checkId === "number") {
		return {
			args: ["api", "-X", "PATCH", `repos/${repo}/check-runs/${checkId}`, "--input", "-"],
			input: JSON.stringify({
				status: "completed",
				conclusion,
				output: { title, summary },
			}),
		};
	}
	return {
		args: ["api", "-X", "POST", `repos/${repo}/check-runs`, "--input", "-"],
		input: JSON.stringify({
			name: "Needlefish",
			head_sha: headSha,
			status: "completed",
			conclusion,
			output: { title, summary },
		}),
	};
}

const SEV_RANK: Record<Finding["severity"], number> = {
	P0: 0,
	P1: 1,
	P2: 2,
	P3: 3,
};

const VERDICT_HEADLINE_WORD: Record<Verdict, string> = {
	pass: "LGTM",
	changes_requested: "CHANGES REQUESTED",
	needs_human: "REVIEW INCOMPLETE. HUMAN CONFIRMATION REQUIRED",
};

function oneLine(text: string): string {
	return text.replace(/\s*\r?\n\s*/g, " ");
}

function truncateLine(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) : text;
}

function sortBySeverity(findings: readonly Finding[]): Finding[] {
	return [...findings].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
}

function topBlockingFinding(
	findings: readonly Finding[],
): Finding | undefined {
	return sortBySeverity(findings).find((f) => f.severity !== "P3");
}

function firstBlockingResidual(
	result: ReviewResult,
): string | undefined {
	return result.residualRisks.find((r) => r.blocks)?.text;
}

function checkRunTitle(result: ReviewResult): string {
	const base = result.verdict === "needs_human"
		? "Needlefish: needs_human. Review incomplete; human confirmation required"
		: `Needlefish: ${result.verdict}`;
	if (result.verdict === "changes_requested") {
		const top = topBlockingFinding(result.findings);
		if (top) return truncateLine(`${base} — ${oneLine(top.title)}`, 120);
	} else if (result.verdict === "needs_human") {
		const text = firstBlockingResidual(result);
		if (text) return truncateLine(`${base} — ${oneLine(text)}`, 120);
	}
	return base;
}

function postIssueComment(repo: string, prNumber: number, body: string, appBotLogin: string | null): void {
	const endpoint = `repos/${repo}/issues/${prNumber}/comments`;
	const read = (): JsonRecord[] => {
		const raw = ghJson(["api", "--paginate", "--slurp", endpoint]);
		if (!Array.isArray(raw)) throw new Error("GitHub returned no comment list");
		return raw.flat(1).filter(isRecord);
	};
	const cappedBody = screenAndCapOutboundBody(body);
	const args = ["api", "-X", "POST", endpoint, "--input", "-"];
	const payload = JSON.stringify({ body: cappedBody });
	let before: Set<unknown>;
	try { before = new Set(read().map((item) => item.id)); }
	catch {
		// A failed pre-read must not suppress the failure explanation. POST remains single-shot.
		ghPost(args, payload);
		return;
	}
	const selfLogin = authenticatedLogin();
	reconciledPost(args, payload,
		() => {
			const matching = read().filter((item) => !before.has(item.id) && item.body === cappedBody);
			const owned = matching.find((item) => isTrustedStateAuthor(item, selfLogin, appBotLogin));
			if (owned) return owned;
			if (matching.length > 0) throw new Error("Cannot verify ownership of the stored comment; not retrying its POST");
			return null;
		});
}

class RecoveryLimitError extends Error {
	constructor() {
		super("Automatic review recovery limit reached. Delivery is incomplete; a plain rerun stops here again. Force a full review with the recheck input or comment `@needlefish recheck`.");
	}
}

// S3: infra-failure comment posted alongside the red check so a red X always
// has something to read in the PR timeline. Fail-soft: never blocks the check.
function postErrorComment(repo: string, prNumber: number, msg: string, advice = "Review did not complete. Re-run the review.", appBotLogin: string | null = null): void {
	const body =
		`⚠️ **Needlefish review FAILED TO RUN** — this red check is an infra failure, not a code verdict.\n\n` +
		"```\n" +
		`${msg.slice(0, 2000)}\n` +
		"```\n\n" +
		`${advice}\n` +
		"<!-- needlefish-error -->";
	try {
		postIssueComment(repo, prNumber, body, appBotLogin);
	} catch (commentErr) {
		const cm = commentErr instanceof Error ? commentErr.message : String(commentErr);
		process.stderr.write(`needlefish: could not post error comment: ${cm}\n`);
	}
}

// S4.1: round comment notifies the PR timeline on re-review (GitHub does not
// notify on review-body edits). Rendered from the full result so the reason
// line stays in sync with the review body's S1 first line.
function buildRoundCommentBody(
	result: ReviewResult,
	headSha: string,
	fates: PriorFateCounts,
	open: readonly Finding[],
	newCount: number,
): string {
	const lines: string[] = [];
	const counts = priorFateParts(fates);
	counts.push(`❌ ${open.length} still open`, `🆕 ${newCount} new`);
	lines.push(
		`**Needlefish re-review** @ ${headSha.slice(0, 7)} — ${counts.join(" · ")} → ${VERDICT_HEADLINE_WORD[result.verdict]}`,
	);
	if (open.length > 0) {
		const top = sortBySeverity(open)[0];
		const loc = top.file ? ` (${top.file}:${top.lineStart})` : "";
		lines.push(`Top open: ${top.severity} ${truncateLine(oneLine(top.title), 120)}${loc}`);
	}
	if (result.verdict !== "pass") {
		lines.push(renderMarkdown(result).split("\n")[0]);
	}
	lines.push("<!-- needlefish-round -->");
	return lines.join("\n");
}

function postRoundComment(
	repo: string,
	prNumber: number,
	body: string,
	appBotLogin: string | null,
): void {
	postIssueComment(repo, prNumber, body, appBotLogin);
}

// GitHub usernames may contain the substring "github-actions";
// z-github-actions-z is registrable (letters, digits, and single hyphens).
export class CosmeticAuthor {
	readonly #match = true;
	private constructor() {}
	static match(): CosmeticAuthor {
		const author = new CosmeticAuthor();
		void author.#match;
		return author;
	}
}

export function isLooselyBotShaped(item: JsonRecord): CosmeticAuthor | null {
	const login = nestedString(item, "user", "login");
	if (!(login.includes("github-actions") || /\[bot\]$/.test(login))) return null;
	return CosmeticAuthor.match();
}

// The identity a GITHUB_TOKEN-authenticated run posts under. Not a target-repo
// noun: it is the fixed platform identity GitHub attributes every Actions
// token to, confirmed against the live reviews API for this repo's own runs
// ({login: "github-actions[bot]", type: "Bot"}).
const ACTIONS_BOT_LOGIN = "github-actions[bot]";

// SECURITY-GRADE author check for needlefish-state markers. See the trust
// boundary note in findPreviousReview for what rides on it.
//
// The rule is "the marker was written by the identity this run posts as",
// never "the marker was written by something bot-shaped". Three ways to
// establish that identity, all attested outside the author's control:
//
//   1. login === selfLogin — the identity `gh api user` reports. Exact
//      equality only, never a prefix/substring, and never when selfLogin is
//      empty. This covers PAT-authenticated self-hosted runners, where our
//      own review carries a plain user login.
//   2. login === ACTIONS_BOT_LOGIN AND user.type === "Bot" — the Actions
//      default identity. Actions tokens are not permitted `GET /user`, so
//      selfLogin is empty in that mode and this branch is what carries the
//      dedupe in production. Both fields are set by GitHub: a human account
//      cannot obtain type "Bot", and "[" / "]" are not legal in a human
//      username, so neither half is forgeable from a normal account.
//
//   3. An explicit App pin replaces both defaults with its check API slug
//      plus "[bot]", with user.type "Bot". A missing slug trusts nobody.
//      Prior markers also need their matching completed check receipt.
//
// Deliberately NOT trusted:
//   - a substring match on the login. That was the original bug:
//     "github-actions" is a substring of the registrable username
//     "z-github-actions-z", so any user could mint a trusted-looking marker.
//   - an unpinned Bot-typed "[bot]" account. A different GitHub App installed on
//     the repo is not us, and trusting it lets it suppress our review.
//
export function isTrustedStateAuthor(item: JsonRecord, selfLogin: string, appBotLogin: string | null = null): boolean {
	const login = nestedString(item, "user", "login");
	if (login === "") return false;
	if (appBotLogin !== null) return login === appBotLogin && nestedString(item, "user", "type") === "Bot";
	if (selfLogin !== "" && login === selfLogin) return true;
	return login === ACTIONS_BOT_LOGIN && nestedString(item, "user", "type") === "Bot";
}

// Self-hosted runners often authenticate gh with a PAT, so Needlefish's own
// round comments carry a plain user login rather than a bot-shaped one.
// Fail-soft: an empty string just narrows recognition back to bot authors.
function authenticatedLogin(): string {
	try {
		const user = ghJson(["api", "user"]);
		return isRecord(user) ? stringField(user, "login") : "";
	} catch {
		return "";
	}
}

// S4.2: minimize prior round and infra-error comments (classifier OUTDATED)
// so the timeline surfaces only the current result. Fail-soft: a minimize
// failure never fails the review.
function minimizePreviousRoundComments(
	repo: string,
	prNumber: number,
): void {
	// --slurp: --paginate alone emits one JSON document PER PAGE (concatenated,
	// unparseable); --slurp wraps the pages into a single outer array.
	const raw = ghJson([
		"api",
		"--paginate",
		"--slurp",
		`repos/${repo}/issues/${prNumber}/comments`,
	]);
	if (!Array.isArray(raw)) return;
	const selfLogin = authenticatedLogin();
	// Each element is a page (an array of comments); flat(1) also tolerates a
	// plain comment list from stubs or older gh versions.
	for (const item of raw.flat(1)) {
		if (!isRecord(item)) continue;
		const body = stringField(item, "body");
		if (
			!body.includes("<!-- needlefish-round -->") &&
			!body.includes("<!-- needlefish-error -->")
		)
			continue;
		// Ours = bot-shaped author, or the identity this run posts as (PAT).
		// The author check keeps humans quoting the marker from being swept.
		// Deliberately the loose predicate: this path is cosmetic (see
		// isLooselyBotShaped) and erring wide only over-collapses a comment,
		// whereas the state-marker path erring wide suppresses a review.
		const author = nestedString(item, "user", "login");
		if (isLooselyBotShaped(item) === null && !(selfLogin && author === selfLogin))
			continue;
		const nodeId = stringField(item, "node_id");
		if (!nodeId) continue;
		const query =
			"mutation($id: ID!) { minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) { minimizedComment { isMinimized } } }";
		ghJson(["api", "graphql", "-f", `query=${query}`, "-f", `id=${nodeId}`]);
	}
}

// The machine-readable reason a GitHub review was skipped, mirrored on
// stdout as `needlefish-skip {json}` alongside the existing prose lines.
export type SkipReason =
	| "closed_pr"
	| "stale_head"
	| "same_head"
	| "untrusted_author";

function emitSkip(reason: SkipReason, prNumber: number, headSha: string): void {
	process.stdout.write(
		`needlefish-skip ${JSON.stringify({ reason, prNumber, headSha })}\n`,
	);
}

// The machine-readable terminal outcome, mirrored on stdout as
// `needlefish-outcome {json}`. This is the ONLY thing the review workflow's
// provider-fallback chain is allowed to read: the rendered review (which the
// model influences) is printed before it, so a changes_requested finding that
// merely quotes "429" or "quota" can never trigger a second model call on
// another provider. The last `needlefish-outcome` line in the combined output
// is always the one this process wrote last.
interface ReviewOutcome {
	readonly outcome: "verdict" | "failure";
	readonly verdict?: Verdict;
	readonly operational?: boolean;
	readonly cause?: string;
	readonly prNumber: number;
	readonly headSha: string;
}

function emitOutcome(outcome: ReviewOutcome): void {
	process.stdout.write(`needlefish-outcome ${JSON.stringify(outcome)}\n`);
}

// The controlled transport-cause vocabulary the runner layer appends to its
// own errors via safeRunnerCause/safeOutputCause. Every producer terminates
// the token with `;`, `.` (the output classifiers append a canned next-step
// sentence), or the end of the message.
// `auth error`/`auth rejected` are deliberately absent: the fallback chain has
// never advanced on auth, and it still must not.
const OPERATIONAL_CAUSE_RE =
	/\blikely cause: (usage limit|rate limited|network error|empty output|truncated output|html error page)(?:[;.]|$)/;

// Messages that only needlefish's own output classifiers can produce. A
// normalization error embeds model-controlled field values verbatim (e.g.
// `invalid severity "<value>"`), so an arbitrary validation message must never
// be trusted even when it contains the token text — only these producers are.
const CONTROLLED_OUTPUT_ERROR_PREFIXES = [
	// extractJson: empty, truncated, or HTML output that could not be parsed.
	"no JSON object found in codex output",
	// direct-HTTP runner: an empty completion body.
	"openai runner: empty content in response",
];

// Node socket-level failures the runner process reports as the cause of a
// typed RunnerOperationalError. These are not text heuristics: the code is set
// by Node/libuv or by runner-process.ts itself, so a model-influenced message
// cannot fabricate one. Both map onto the existing "network error" token.
const OPERATIONAL_ERROR_CODES: Record<string, true | undefined> = {
	ETIMEDOUT: true, // runner-process.ts RunnerTimeoutError
	EIDLETIMEDOUT: true, // runner-process.ts RunnerIdleTimeoutError
	ECONNREFUSED: true,
	ENOTFOUND: true,
	EAI_AGAIN: true,
};

// The direct-HTTP runner stamps its upstream status into the message. Typed
// prefix, not a text scan: only this runner produces it, and the status is the
// gateway's own. 429 is a rate limit; 5xx is a transport failure.
const OPERATIONAL_HTTP_RE = /^openai runner HTTP (\d{3})\b/;

// operational=true means "the runner or its upstream transport failed in a
// recognized way", which is the only condition the provider chain advances on.
// Trust is established first — a typed RunnerOperationalError somewhere in the
// cause chain, or a message from a controlled output-classifier producer — and
// only then are the recognized signals read: the controlled `likely cause`
// token, a socket error code, or the direct-HTTP runner's status. An arbitrary
// validation message, the review output, and any other success-path text can
// never mark a failure operational.
function runnerOperationalCause(err: unknown): string | undefined {
	const chain: Error[] = [];
	let current: unknown = err;
	for (let depth = 0; current instanceof Error && depth < 10; depth++) {
		chain.push(current);
		current = current.cause;
	}
	const typed = chain.some((e) => e instanceof RunnerOperationalError);
	const trustedOutput = chain.some((e) =>
		CONTROLLED_OUTPUT_ERROR_PREFIXES.some((prefix) =>
			e.message.startsWith(prefix),
		),
	);
	if (!typed && !trustedOutput) return undefined;
	for (const e of chain) {
		const token = OPERATIONAL_CAUSE_RE.exec(e.message);
		if (token) return token[1];
	}
	if (typed) {
		for (const e of chain) {
			// Node and runner-process.ts attach `code` to these errors; the cast
			// only names the well-known extension.
			const { code } = e as Error & { readonly code?: unknown };
			if (typeof code === "string" && OPERATIONAL_ERROR_CODES[code] === true) {
				return "network error";
			}
		}
		for (const e of chain) {
			const http = OPERATIONAL_HTTP_RE.exec(e.message);
			if (!http) continue;
			const status = Number(http[1]);
			if (status === 429) return "rate limited";
			if (status >= 500 && status <= 599) return "network error";
		}
	}
	return undefined;
}

type PrAuthor = { readonly association: string; readonly type: string };

const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
	"OWNER",
	"MEMBER",
	"COLLABORATOR",
]);

// Model CLIs run unrestricted on trusted runners, so the PR author (whose
// title and body reach the model) must be trusted. An unreadable author
// throws instead of skipping: the neutral skip check is terminal for
// reconciliation, so a misclassified transient read would never be retried.
function prAuthor(pr: JsonRecord): PrAuthor {
	const association = pr.author_association;
	const type = isRecord(pr.user) ? pr.user.type : undefined;
	if (
		typeof association !== "string" ||
		!association ||
		typeof type !== "string" ||
		!type
	) {
		throw new Error(
			"GitHub PR response has no author_association or user.type; cannot classify the PR author",
		);
	}
	return { association, type };
}

function isTrustedAuthor(author: PrAuthor): boolean {
	return TRUSTED_ASSOCIATIONS.has(author.association) && author.type !== "Bot";
}

function postReviewSkipReason(
	repo: string,
	prNumber: number,
	headSha: string,
): SkipReason | null {
	return skipReasonForPr(ghJson(["api", `repos/${repo}/pulls/${prNumber}`]), prNumber, headSha);
}

function skipReasonForPr(pr: unknown, prNumber: number, headSha: string): SkipReason | null {
	if (!isRecord(pr)) throw new Error("GitHub PR response was not an object");
	const state = stringField(pr, "state");
	if (state !== "open") {
		process.stdout.write(
			`Needlefish skipped posting for PR #${prNumber} because state is ${state || "unknown"}.\n`,
		);
		return "closed_pr";
	}
	const currentHeadSha = nestedString(pr, "head", "sha");
	if (currentHeadSha !== headSha) {
		process.stdout.write(
			`Needlefish skipped stale result for PR #${prNumber}: ${headSha} is no longer current.\n`,
		);
		return "stale_head";
	}
	return null;
}

function readCheckRuns(repo: string, headSha: string): JsonRecord[] {
	const raw = ghJson(["api", "--paginate", "--slurp",
		`repos/${repo}/commits/${headSha}/check-runs?check_name=Needlefish&filter=all&per_page=100`]);
	const pages = Array.isArray(raw) ? raw : [raw];
	const runs: JsonRecord[] = [];
	for (const page of pages) {
		if (!isRecord(page) || !Array.isArray(page.check_runs)) throw new Error("GitHub returned no check runs");
		runs.push(...page.check_runs.filter(isRecord));
	}
	return runs.sort((a, b) => Number(b.id) - Number(a.id));
}

function completedCheckVerdict(state: RoundState, checks: readonly JsonRecord[], prNumber: number): Verdict | null {
	if (state.v !== 2) return null;
	const receipt = state.delivery;
	const run = checks.find((check) => check.id === receipt.checkId);
	if (!run || run.head_sha !== state.headSha || !isRecord(run.app) || run.app.id !== receipt.appId ||
		run.name !== "Needlefish" || run.status !== "completed") return null;
	const round = parseCheckRound(run.external_id);
	if (!round || round.prNumber !== prNumber || round.roundId !== receipt.roundId || round.runId !== receipt.runId) return null;
	const conclusion = stringField(run, "conclusion");
	const title = nestedString(run, "output", "title");
	if (conclusion === "success" && title === "Needlefish: pass") return "pass";
	if (conclusion !== "failure") return null;
	if (title.startsWith("Needlefish: needs_human")) return "needs_human";
	if (title.startsWith("Needlefish: changes_requested")) return "changes_requested";
	return null;
}

function deliveredVerdict(state: RoundState, checks: readonly JsonRecord[], prNumber: number, expectedAppId: number | null): Verdict | null {
	if (state.v !== 2) return null;
	const receipt = state.delivery;
	const owned = checks.some((check) => check.id === receipt.checkId && ownedCheckAppId(check.app, expectedAppId) === receipt.appId);
	return owned ? completedCheckVerdict(state, checks, prNumber) : null;
}

// Any newer owned round for this PR and head invalidates the receipt, including
// in_progress rounds (orphaned or concurrent). This replaces #257's "ignore
// in_progress" rule; the recovery budget, not the skip, bounds the rerun (#102).
function hasNewerRound(state: RoundState, checks: readonly JsonRecord[], prNumber: number): boolean {
	if (state.v !== 2) return false;
	const receipt = state.delivery;
	return checks.some((check) => typeof check.id === "number" && check.id > receipt.checkId &&
		check.head_sha === state.headSha && isRecord(check.app) && check.app.id === receipt.appId &&
		check.name === "Needlefish" && parseCheckRound(check.external_id)?.prNumber === prNumber);
}

function reconciledPost(args: readonly string[], input: string, read: () => unknown | null): unknown {
	try {
		return ghPost(args, input);
	} catch (error) {
		if (!isTransientGh5xx(error)) throw error;
		for (let attempt = 1; attempt <= GH_POST_ATTEMPTS; attempt++) {
			const existing = read();
			if (existing !== null) return existing;
			if (attempt < GH_POST_ATTEMPTS) {
				const delay = ghPostRetryBaseMs() * attempt;
				if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
			}
		}
		throw error;
	}
}

function readReviews(repo: string, prNumber: number): JsonRecord[] {
	const raw = ghJson(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${prNumber}/reviews`]);
	if (!Array.isArray(raw)) throw new Error("GitHub returned no review list");
	return raw.flat(1).filter(isRecord);
}

// A job timeout or watchdog terminates the process while the owned check is
// in_progress, and a consumer workflow has nothing else that completes it.
// Runs inside the termination grace, off the event loop. Same stale-head rule
// as the error path: a moved head or closed PR gets a neutral superseded
// completion and nothing on the timeline. A current head gets a failure that
// names the termination, not a code defect, and no timeline comment either,
// since nothing was reviewed.
async function completeTerminatedCheck(
	repo: string,
	prNumber: number,
	headSha: string,
	checkId: number,
	termination: Termination,
	claimCheck: () => boolean,
): Promise<void> {
	let skipReason: SkipReason | null = null;
	try {
		const pr = await ghJsonWhileTerminating(termination, ["api", `repos/${repo}/pulls/${prNumber}`]);
		skipReason = skipReasonForPr(pr, prNumber, headSha);
	} catch (probeErr) {
		const pm = probeErr instanceof Error ? probeErr.message : String(probeErr);
		process.stderr.write(
			`needlefish: could not re-read PR state during termination; completing the check anyway: ${pm}\n`,
		);
	}
	const write =
		skipReason !== null
			? checkCompletion(
					repo,
					headSha,
					null,
					"neutral",
					"Needlefish: superseded",
					`The review was terminated and the head is stale or the PR closed; nothing is posted for this head. reason=${skipReason}`,
					checkId,
				)
			: checkCompletion(
					repo,
					headSha,
					null,
					"failure",
					"Needlefish: review terminated",
					`Needlefish received ${termination.signal} before the review completed (job timeout, cancellation, or watchdog) and did NOT pass this PR. This is not a code verdict.\n\nRe-trigger: push a new commit or re-run with --recheck.`,
					checkId,
				);
	// Claimed only now: a verdict that became ready during the re-read above
	// has already claimed and posted itself, and this PATCH must not overwrite it.
	if (termination.cancelled.aborted || !claimCheck()) return;
	if (skipReason !== null) emitSkip(skipReason, prNumber, headSha);
	const input = screenedInput(write.input);
	const started = Date.now();
	try {
		await ghJsonWhileTerminating(termination, write.args, input);
		return;
	} catch (error) {
		// One retry, and only when the backoff plus another attempt as slow as
		// this one fits before the deadline. A timeout or abort is not retried.
		if (termination.cancelled.aborted || !isTransientGh5xx(error)) throw error;
		const backoffMs = ghPostRetryBaseMs();
		const fits = termination.deadlineMs - Date.now() >= backoffMs + (Date.now() - started);
		if (!fits) throw error;
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`needlefish: check completion failed during termination; retrying once: ${message}\n`);
		await sleep(backoffMs, undefined, { signal: termination.cancelled });
	}
	await ghJsonWhileTerminating(termination, write.args, input);
}

export function configuredCheckAppId(): number | null {
	const appIdInput = process.env.NEEDLEFISH_CHECK_APP_ID || undefined;
	const expectedAppId = appIdInput === undefined ? null : Number(appIdInput);
	if (appIdInput !== undefined && (!/^[1-9]\d*$/.test(appIdInput) || !Number.isSafeInteger(expectedAppId))) {
		throw new Error("NEEDLEFISH_CHECK_APP_ID must be a positive safe integer");
	}
	return expectedAppId;
}

export async function runGithub(
	cwd: string,
	prNumber: number,
	opts: RunnerOptions = {},
	recheck = false,
): Promise<void> {
	const expectedAppId = configuredCheckAppId();
	const repoPath = path.resolve(cwd);
	const repo = process.env.GITHUB_REPOSITORY;
	if (!repo) throw new Error("GITHUB_REPOSITORY not set (must run in Actions)");

	const pr = ghJson(["api", `repos/${repo}/pulls/${prNumber}`]);
	if (!isRecord(pr)) throw new Error("GitHub PR response was not an object");
	const state = stringField(pr, "state");
	if (state !== "open") {
		process.stdout.write(
			`Needlefish skipped PR #${prNumber} because state is ${state || "unknown"}.\n`,
		);
		// No git fallback here: a closed PR may not even have a local checkout,
		// and the skip line reports the PR's own head (env or API).
		emitSkip(
			"closed_pr",
			prNumber,
			process.env.PR_HEAD_SHA || nestedString(pr, "head", "sha") || "",
		);
		return;
	}
	const author = prAuthor(pr);
	if (
		!isTrustedAuthor(author) &&
		!envFlagOn("NEEDLEFISH_ALLOW_UNTRUSTED_AUTHOR")
	) {
		const prHead = process.env.PR_HEAD_SHA || nestedString(pr, "head", "sha");
		if (!prHead) throw new Error("Could not resolve PR head SHA");
		const reason = `PR author (association ${author.association}, type ${author.type}) is not trusted`;
		process.stdout.write(`Needlefish skipped PR #${prNumber}: ${reason}.\n`);
		postCheck(
			repo,
			prHead,
			null,
			"neutral",
			"Needlefish: skipped (author not trusted)",
			`Needlefish runs model CLIs unrestricted on trusted runners, so it reviews only PRs opened by an OWNER, MEMBER, or COLLABORATOR that is not a bot. ${reason}. A maintainer who has read this PR can review it by re-running with NEEDLEFISH_ALLOW_UNTRUSTED_AUTHOR=1 (the review workflow's allow_untrusted_author: true input sets it).`,
		);
		emitSkip("untrusted_author", prNumber, prHead);
		return;
	}
	const currentHeadSha = nestedString(pr, "head", "sha");
	if (!currentHeadSha) throw new Error("PR API returned no head.sha; cannot resolve or verify PR head");
	const headSha = process.env.PR_HEAD_SHA || currentHeadSha;
	const entrySkipReason = skipReasonForPr(pr, prNumber, headSha);
	if (entrySkipReason) {
		emitSkip(entrySkipReason, prNumber, headSha);
		return;
	}

	let previous: ReturnType<typeof findPreviousReview> | undefined;
	try { previous = findPreviousReview(repo, prNumber, expectedAppId); }
	catch (error) {
		process.stderr.write(`needlefish: could not read prior review identity: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	let checks: JsonRecord[] | null = null;
	try { checks = readCheckRuns(repo, headSha); }
	catch (error) {
		process.stderr.write(`needlefish: could not read delivery checks: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	let previousChecks = previous?.state.headSha === headSha ? checks : null;
	if (previous && previous.state.headSha !== headSha) {
		try { previousChecks = readCheckRuns(repo, previous.state.headSha); }
		catch { previousChecks = null; }
	}
	const previousVerdict = previous && previousChecks ? deliveredVerdict(previous.state, previousChecks, prNumber, expectedAppId) : null;
	const prev = previousVerdict !== null ? previous : null;
	if (prev && previousVerdict !== null && prev.state.headSha === headSha && !recheck &&
		checks && !hasNewerRound(prev.state, checks, prNumber)) {
		process.exitCode = reviewExitCode(previousVerdict);
		process.stderr.write(`needlefish: head ${headSha} already reviewed; pass --recheck to force.\n`);
		emitSkip("same_head", prNumber, headSha);
		return;
	}

	// Connection parse, selection and credential errors fail here, before a
	// check exists, so they do not spend a recovery round. A docs-only head
	// never reaches a runner, so missing credentials do not stop it.
	resolveConnectionOptions(opts, repoPath, process.env, false);
	try {
		resolveConnectionOptions(opts, repoPath, process.env, true);
	} catch (error) {
		if (!docsOnlyHead(repoPath, process.env.PR_BASE_SHA || nestedString(pr, "base", "sha"), headSha)) throw error;
	}
	const round: CheckRound = { v: 2, prNumber, roundId: randomUUID(), runId: process.env.GITHUB_RUN_ID || "", recheck };
	const pending = createPendingCheck(repo, headSha, round, expectedAppId);
	const pendingCheckId = pending?.id ?? null;
	// The owned check reaches a terminal state exactly once, and whoever holds
	// the claim completes it. The result path claims before posting anything
	// and, if a post then throws, still completes the check from the catch.
	// The termination finalizer claims right before its PATCH. A verdict
	// ready before that PATCH wins and is posted in full. A verdict ready
	// after it posts nothing, not even the review body: a rerun must
	// re-review this head rather than dedupe on a review whose check says
	// the run was terminated.
	let checkOwner: "result" | "finalizer" | null = null;
	const claimCheck = (owner: "result" | "finalizer"): boolean => {
		if (checkOwner === null) checkOwner = owner;
		return checkOwner === owner;
	};
	const detachFinalizer =
		pendingCheckId === null
			? () => true
			: registerTerminationFinalizer((termination) =>
					completeTerminatedCheck(repo, prNumber, headSha, pendingCheckId, termination, () =>
						claimCheck("finalizer"),
					),
				);

	try {
		if (!pending) throw new Error("Review delivery could not start; rerun the review");
		if (previous === undefined) throw new Error("Prior review identity is unreadable; rerun the review");
		if (!checks) throw new Error("Review delivery history is unreadable; rerun the review");
		if (previous && !previousChecks) throw new Error("Prior review delivery history is unreadable; rerun the review");
		const delivery: DeliveryReceipt = { checkId: pending.id, appId: pending.appId, roundId: round.roundId, runId: round.runId };
		const deliveredCheckId = prev?.state.v === 2 && prev.state.headSha === headSha ? prev.state.delivery.checkId : null;
		const priorRounds: CheckRound[] = [];
		for (const check of checks) {
			if (deliveredCheckId !== null && typeof check.id === "number" && check.id <= deliveredCheckId) continue;
			if (!isRecord(check.app) || check.app.id !== pending.appId || check.head_sha !== headSha || check.name !== "Needlefish") continue;
			const prior = parseCheckRound(check.external_id);
			// A workflow receipt is not a review attempt, so it spends no recovery budget.
			if (!prior || prior.prNumber !== prNumber || prior.recheck === undefined) continue;
			priorRounds.push(prior);
			if (prior.recheck) break;
		}
		const recoveryAttempt = recheck ? 0 : deliveredCheckId !== null ? priorRounds.length : Math.max(priorRounds.length, previous?.state.headSha === headSha ? 1 : 0);
		if (recoveryAttempt > 1) throw new RecoveryLimitError();
		const baseSha = process.env.PR_BASE_SHA || nestedString(pr, "base", "sha");
		if (!baseSha) throw new Error("Could not resolve PR base SHA");
		const {
			baseSha: mergeBase,
			patch,
			patchStat,
			changedFiles: changed,
		} = prDiffFromShas(repoPath, baseSha, headSha);

		const commentsUrl = stringField(pr, "comments_url");
		const reviewsUrl = stringField(pr, "review_comments_url");
		const comments = commentsUrl ? ghJson(["api", commentsUrl]) : [];
		const reviews = reviewsUrl ? ghJson(["api", reviewsUrl]) : [];
		const selfLogin = authenticatedLogin();
		const ownAuthor = (item: JsonRecord) => isTrustedStateAuthor(item, selfLogin);

		const prMeta = {
			number: prNumber,
			title: stringField(pr, "title"),
			body: typeof pr.body === "string" ? pr.body : null,
			comments: normalizeBodyList(comments, ownAuthor),
			reviews: normalizeBodyList(reviews, ownAuthor),
			checks: [],
		};

		const bundle = makeBundle({
			repoPath,
			baseSha: mergeBase,
			headSha,
			patch,
			patchStat,
			changedFiles: changed,
			prMeta,
			deep: false,
			focus: null,
			agentsMd: readAgentsAt(repoPath, headSha),
		});
		const resolvedOpts = resolveConnectionOptions(opts, repoPath, process.env, !isDocsOnlyFastPath(bundle));

		// Scope and base-tip fields are attached after review(): anything on
		// the bundle reaches the model via {{BUNDLE}}, so human-facing surface
		// data lives only on the result and the prompt stays byte-identical.
		const result: ReviewResult = {
			...(await review(bundle, resolvedOpts)),
			reviewTarget: `Review target: PR #${prNumber} ${mergeBase}..${headSha}`,
			prNumber,
			prBaseSha: baseSha,
		};
		if (!claimCheck("result")) return;
		const conclusion = VERDICT_CONCLUSION[result.verdict];
		const skipReason = postReviewSkipReason(repo, prNumber, headSha);
		if (skipReason) {
			// Head moved or PR closed while reviewing: close our own check so it
			// cannot hang as in_progress forever. Timeline comments stay
			// suppressed for the stale head exactly as before.
			emitSkip(skipReason, prNumber, headSha);
			postCheck(
				repo,
				headSha,
				result,
				"neutral",
				"Needlefish: superseded",
				`A newer head was pushed while this review ran; its result is not posted. reason=${skipReason}`,
				pendingCheckId,
			);
			return;
		}
		process.exitCode = reviewExitCode(result.verdict);
		// Run before posting this result so fresh round comments are not swept.
		// This also clears stale infra-error comments when the first successful
		// review has no previous state-bearing review.
		try {
			minimizePreviousRoundComments(repo, prNumber);
		} catch (minErr) {
			const mm = minErr instanceof Error ? minErr.message : String(minErr);
			process.stderr.write(
				`needlefish: could not minimize previous comments: ${mm}\n`,
			);
		}

		if (prev) {
			const { fresh, open, unmatched } = matchFindings(
				prev.state.findings,
				result.findings,
			);
			// A blocking residual means this round could not reach a verdict
			// (every failed or timed-out deep pass leaves one), so its silence
			// on a prior finding proves nothing. Residuals carry no file list,
			// so the whole round is treated as unable to vouch.
			const roundIncomplete = result.residualRisks.some((risk) => risk.blocks);
			const fates = classifyUnmatched(
				unmatched,
				unmatched.length > 0 && !roundIncomplete
					? touchesSincePrevHead(repoPath, prev.state.headSha, headSha)
					: null,
			);
			const freshResult: ReviewResult = { ...result, findings: fresh };
			const { comments: freshComments, inlined: freshInlined } =
				buildInlineComments(freshResult, patch, {
					repoPath,
					headSha,
				});
			const renderOpts = {
				inlinedFindings: freshInlined,
				openFindings: open,
				priorFates: fates,
				// New = not matched to a previous-round key.
				newCount: fresh.length,
				repoSlug: repo,
			};
			const body = renderMarkdown(freshResult, {
				...renderOpts,
				omitCoverageGaps: true,
			});
			updateReviewBody(repo, prNumber, prev.id, body);
			// Fail-soft: the round comment is cosmetic; a transient POST failure
			// must not throw to the outer catch, which would replace a computed
			// verdict check-run with a red "review failed" one.
			try {
				postRoundComment(
					repo,
					prNumber,
					buildRoundCommentBody(
						result,
						headSha,
						fates,
						open,
						renderOpts.newCount,
					),
					pending.botLogin,
				);
			} catch (roundErr) {
				const rm = roundErr instanceof Error ? roundErr.message : String(roundErr);
				process.stderr.write(
					`needlefish: could not post round comment: ${rm}\n`,
				);
			}
			if (freshComments.length > 0) {
				postReview(repo, prNumber, headSha, "", freshComments, pending.botLogin);
			}
			await applyVerdictLabel(repo, prNumber, result.verdict);
			const summary = renderMarkdown(freshResult, renderOpts);
			postCheck(
				repo,
				headSha,
				result,
				conclusion,
				checkRunTitle(result),
				summary,
				pendingCheckId,
			);
			persistStateMarker(
				repo,
				prNumber,
				prev.id,
				renderMarkdown(freshResult, {
					...renderOpts,
					stateMarker: renderState(headSha, result.findings, delivery),
					omitCoverageGaps: true,
				}),
			);
			process.stdout.write(stdoutSummary(summary));
			emitOutcome({
				outcome: "verdict",
				verdict: result.verdict,
				prNumber,
				headSha,
			});
		} else {
			const { comments, inlined } = buildInlineComments(result, patch, {
				repoPath,
				headSha,
			});
			const renderOpts = { inlinedFindings: inlined, repoSlug: repo };
			// Body first, WITHOUT the state marker: the review content is the
			// deliverable and fails hard. The dedupe marker rides a separate
			// write at the very end, once delivery has actually completed.
			const body = renderMarkdown(result, {
				...renderOpts,
				omitCoverageGaps: true,
			});
			const reviewId = postReview(repo, prNumber, headSha, body, comments, pending.botLogin);
			await applyVerdictLabel(repo, prNumber, result.verdict);
			const summary = renderMarkdown(result, renderOpts);
			postCheck(
				repo,
				headSha,
				result,
				conclusion,
				checkRunTitle(result),
				summary,
				pendingCheckId,
			);
			persistStateMarker(
				repo,
				prNumber,
				reviewId,
				renderMarkdown(result, {
					...renderOpts,
					stateMarker: renderState(headSha, result.findings, delivery),
					omitCoverageGaps: true,
				}),
			);
			process.stdout.write(stdoutSummary(summary));
			emitOutcome({
				outcome: "verdict",
				verdict: result.verdict,
				prNumber,
				headSha,
			});
		}
	} catch (err) {
		// A signal mid-review hands the check to the finalizer, and the
		// coordinator exits the process; post nothing here. Unless this path
		// already claimed the check and then failed to post: the finalizer
		// will not complete a claimed check, so this path must.
		if (checkOwner !== "result" && !detachFinalizer()) return;
		claimCheck("result");
		const rawMsg = err instanceof Error ? err.message : String(err);
		// A thrown message can carry runner or model text. Replacing a withheld
		// one keeps the failure check below from being withheld too, which
		// would leave the pending check in_progress.
		const screenedMsg = screenText(rawMsg, credentialValuesFromEnv(process.env));
		const msg =
			screenedMsg.kind === "withheld"
				? WITHHELD_MESSAGE
				: outboundText(rawMsg, screenedMsg);
		// The pending check must ALWAYS reach a terminal state — an in_progress
		// check on a stale head would hang forever otherwise. When the stale
		// probe itself fails, staleness is unknown: the check still completes
		// (harmless on an old head), but the timeline stays untouched.
		let skipReason: SkipReason | null = null;
		let staleUnknown = false;
		try {
			skipReason = postReviewSkipReason(repo, prNumber, headSha);
		} catch (probeErr) {
			staleUnknown = true;
			const pm = probeErr instanceof Error ? probeErr.message : String(probeErr);
			process.stderr.write(`needlefish: could not re-read PR state: ${pm}\n`);
		}
		if (skipReason !== null) {
			// The review errored AND the head moved or the PR closed: close our
			// own check as superseded so it cannot hang, but post nothing to
			// the timeline — no verdict, no error comment — for a stale head.
			emitSkip(skipReason, prNumber, headSha);
			try {
				if (pendingCheckId !== null) postCheck(
					repo,
					headSha,
					null,
					"neutral",
					"Needlefish: superseded",
					`The review errored and the head is stale or the PR closed; nothing is posted for this head. reason=${skipReason}`,
					pendingCheckId,
				);
			} catch (checkErr) {
				const cm =
					checkErr instanceof Error ? checkErr.message : String(checkErr);
				process.stderr.write(
					`needlefish: could not post superseded check: ${cm}\n`,
				);
			}
		} else {
			// Check run and error comment are independent fail-soft attempts: a
			// failure of either GitHub endpoint must not suppress the other, nor
			// the stderr line and exit code below.
			try {
				if (pendingCheckId !== null) postCheck(
					repo,
					headSha,
					null,
					"failure",
					"Needlefish: review failed",
					`Review errored and did NOT pass this PR.\n\n\`\`\`\n${msg.slice(0, 4000)}\n\`\`\``,
					pendingCheckId,
				);
			} catch (checkErr) {
				const cm =
					checkErr instanceof Error ? checkErr.message : String(checkErr);
				process.stderr.write(
					`needlefish: could not post failure check: ${cm}\n`,
				);
			}
			// S3: post a PR comment so a red X always has something to read.
			if (!staleUnknown) postErrorComment(repo, prNumber, msg, err instanceof RecoveryLimitError ? "A plain rerun stops here again. Force a full review with the recheck input or comment `@needlefish recheck`." : undefined, pending?.botLogin);
		}
		process.stderr.write(`needlefish review failed: ${msg}\n`);
		process.exitCode = 1;
		// Machine-readable outcome LAST, after every diagnostic above: `msg` can
		// embed model-controlled text (a malformed severity is echoed verbatim),
		// including a newline followed by a fake `needlefish-outcome` line, so
		// the real outcome must be written after it to stay the last one the
		// workflow reads. operational=true only for a recognized runner/
		// transport cause; a superseded head can never be delivered by another
		// provider, so it stays false.
		const cause = skipReason === null ? runnerOperationalCause(err) : undefined;
		emitOutcome({
			outcome: "failure",
			operational: cause !== undefined,
			...(cause !== undefined ? { cause } : {}),
			prNumber,
			headSha,
		});
	} finally {
		detachFinalizer();
	}
}
