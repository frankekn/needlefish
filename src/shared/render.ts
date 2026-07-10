import type { Finding, ReviewResult, Severity, Verdict } from "./schema.js";

const SEV_ORDER: Record<Severity, number> = {
	P0: 0,
	P1: 1,
	P2: 2,
	P3: 3,
};

const SEVERITY_LABEL: Record<Severity, string> = {
	P0: "🔴 P0",
	P1: "🟠 P1",
	P2: "🟡 P2",
	P3: "⚪ P3",
};

const VERDICT_HEADLINE: Record<Verdict, string> = {
	pass: "LGTM ✅",
	changes_requested: "CHANGES REQUESTED ⚠️",
	needs_human: "NEEDS HUMAN 👀",
};

export function renderMarkdown(
	result: ReviewResult,
	opts?: {
		inlinedFindings?: ReadonlySet<Finding>;
		openFindings?: readonly Finding[];
		resolvedCount?: number;
		newCount?: number;
		repoSlug?: string;
		stateMarker?: string;
	},
): string {
	const lines: string[] = [];
	const summary = firstSentence(result.summary);
	lines.push(
		`${VERDICT_HEADLINE[result.verdict]}${summary ? ` — ${summary}` : ""}`,
	);

	const blockingCount = result.findings.filter(
		(finding) => finding.severity !== "P3",
	).length;
	const nitCount = result.findings.length - blockingCount;
	const findingCounts: string[] = [];
	if (blockingCount > 0) findingCounts.push(`**${blockingCount} blocking**`);
	if (nitCount > 0) {
		findingCounts.push(`${nitCount} ${nitCount === 1 ? "nit" : "nits"}`);
	}
	if (findingCounts.length > 0) lines.push(findingCounts.join(" · "));

	const delta: string[] = [];
	if (opts?.resolvedCount && opts.resolvedCount > 0) {
		delta.push(`✅ ${opts.resolvedCount} resolved`);
	}
	if (opts?.newCount && opts.newCount > 0) {
		delta.push(`🆕 ${opts.newCount} new`);
	}
	if (delta.length > 0) lines.push(delta.join(" · "));

	if (result.reviewTarget) {
		lines.push("");
		lines.push(...result.reviewTarget.split("\n"));
	}

	const findings = [...result.findings].sort(
		(a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity],
	);
	const inlinedSet = opts?.inlinedFindings;

	lines.push("");
	lines.push("## Findings");
	lines.push("");
	if (findings.length === 0) {
		lines.push("No actionable findings. Prefer this over padding weak ones.");
	} else {
		lines.push("| # | Severity | Finding | Location |");
		lines.push("|---|----------|---------|----------|");
		findings.forEach((finding, index) => {
			const inlineMarker = inlinedSet?.has(finding)
				? " <sub>(inline comment)</sub>"
				: "";
			lines.push(
				`| ${index + 1} | ${SEVERITY_LABEL[finding.severity]} | ${tableText(finding.title)}${inlineMarker} | ${tableLocation(finding, opts?.repoSlug, result.headSha)} |`,
			);
		});

		const detailed = findings
			.map((finding, index) => ({ finding, number: index + 1 }))
			.filter(({ finding }) => !inlinedSet?.has(finding));
		if (detailed.length > 0) {
			lines.push("");
			lines.push("<details>");
			lines.push("<summary>Finding details</summary>");
			lines.push("");
			detailed.forEach(({ finding, number }, index) => {
				if (index > 0) lines.push("");
				lines.push(
					`### ${SEVERITY_LABEL[finding.severity]} F${number}: ${oneLine(finding.title)}`,
				);
				lines.push("");
				lines.push(`**Problem:** ${finding.whyItBreaks}`);
				lines.push("");
				lines.push(`**Fix:** ${finding.suggestedFix}`);
				if (finding.validation) {
					lines.push("");
					lines.push(`**Validation:** ${finding.validation}`);
				}
			});
			lines.push("");
			lines.push("</details>");
		}
	}

	if (opts?.openFindings && opts.openFindings.length > 0) {
		lines.push("");
		lines.push("<details>");
		lines.push(`<summary>Still open (${opts.openFindings.length})</summary>`);
		lines.push("");
		for (const finding of opts.openFindings) {
			lines.push(
				`- **${finding.severity}** ${oneLine(finding.title)} — ${plainLocation(finding)}`,
			);
		}
		lines.push("");
		lines.push("</details>");
	}

	if (result.checked.length > 0) {
		lines.push("");
		lines.push("<details>");
		lines.push(`<summary>Checked (${result.checked.length})</summary>`);
		lines.push("");
		for (const checked of result.checked) lines.push(`- ${checked}`);
		lines.push("");
		lines.push("</details>");
	}

	if (result.residualRisks.length > 0) {
		lines.push("");
		lines.push("<details>");
		lines.push(
			`<summary>Residual risk (${result.residualRisks.length})</summary>`,
		);
		lines.push("");
		for (const risk of result.residualRisks) {
			lines.push(`- ${risk.blocks ? "⛔ " : ""}${risk.text}`);
		}
		lines.push("");
		lines.push("</details>");
	}

	if (result.stats && result.stats.length > 0) {
		const retries = result.stats.reduce(
			(sum, stat) => sum + (stat.attempts - 1),
			0,
		);
		const calls = result.stats
			.map(
				(stat) =>
					`${stat.label} ${formatDuration(stat.durationMs)}${stat.ok ? "" : " ✗"}`,
			)
			.join(" → ");
		const parts = [
			`${result.stats.length} call${result.stats.length === 1 ? "" : "s"}`,
			calls,
		];
		if (retries > 0)
			parts.push(`${retries} ${retries === 1 ? "retry" : "retries"}`);
		if (result.totalDurationMs !== undefined) {
			parts.push(`total ${formatDuration(result.totalDurationMs)}`);
		}
		lines.push("");
		lines.push(`<sub>${parts.join(" · ")}</sub>`);
	}

	let output = `${lines.join("\n").trim()}\n`;
	if (opts?.stateMarker) output += `\n${opts.stateMarker}\n`;
	return output;
}

function firstSentence(summary: string): string {
	const normalized = oneLine(summary).trim();
	if (!normalized) return "";
	const sentenceEnd = /[.!?](?=\s|$)/.exec(normalized);
	const sentence = sentenceEnd
		? normalized.slice(0, sentenceEnd.index + 1)
		: normalized;
	return sentence.slice(0, 180).trimEnd();
}

function oneLine(text: string): string {
	return text.replace(/\s*\r?\n\s*/g, " ");
}

function tableText(text: string): string {
	return oneLine(text).replace(/\|/g, "\\|");
}

function tableLocation(
	finding: Finding,
	repoSlug?: string,
	headSha?: string,
): string {
	if (!finding.file) return "—";
	const location = tableText(plainLocation(finding));
	if (!repoSlug || !headSha) return `\`${location}\``;
	const encodedPath = finding.file
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	const end =
		finding.lineEnd !== finding.lineStart ? `-L${finding.lineEnd}` : "";
	return `[\`${location}\`](https://github.com/${repoSlug}/blob/${headSha}/${encodedPath}#L${finding.lineStart}${end})`;
}

function plainLocation(finding: Finding): string {
	const end =
		finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : "";
	return `${finding.file || "(no file)"}:${finding.lineStart}${end}`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	return minutes > 0 ? `${minutes}m ${totalSeconds % 60}s` : `${totalSeconds}s`;
}
