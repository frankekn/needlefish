import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveRunner } from "./runner-detection.js";
import type { RunnerName, RunnerOptions } from "./runner.js";

export type RepositoryCapability = "repositoryRead" | "promptOnly" | "unknown";

// Adapter capabilities, not model names or claims made by an agent. ACP is a
// transport: initialize alone says nothing about the launcher's own repo tools.
const REPOSITORY_CAPABILITY: Readonly<Record<RunnerName, RepositoryCapability>> = {
	codex: "repositoryRead",
	claude: "repositoryRead",
	opencode: "repositoryRead",
	grok: "repositoryRead",
	pi: "repositoryRead",
	openai: "promptOnly",
	acp: "unknown",
};

export type ReviewPreflight =
	| { readonly status: "not_required"; readonly requiredCapability: "none" }
	| {
			readonly status: "ready";
			readonly requiredCapability: "repositoryRead";
			readonly runner: RunnerName;
			readonly capability: "repositoryRead";
			readonly capabilitySource: "adapter" | "operator_declared";
	  }
	| {
			readonly status: "unsupported";
			readonly requiredCapability: "repositoryRead";
			readonly runner?: RunnerName;
			readonly capability: "promptOnly" | "unknown";
			readonly code: "unsupported_runner_capability" | "runner_unavailable";
			readonly message: string;
	  };

// An operator may attest a tested, pinned ACP launcher. This is NOT protocol
// negotiation or automated tool verification. A new/unmatched launcher stays
// unknown. Never read this declaration from the target repo or model output.
function hasAcpRepositoryDeclaration(): boolean {
	// Match runAcp() exactly: do not hash a different whitespace-suffixed file.
	const bin = process.env.NEEDLEFISH_ACP_BIN?.trim();
	const digest = process.env.NEEDLEFISH_ACP_REPOSITORY_READ_SHA256;
	if (!bin || !path.isAbsolute(bin) || !digest || !/^[a-f\d]{64}$/i.test(digest)) {
		return false;
	}
	try {
		const stat = statSync(bin);
		// Declarations are for small, operator-owned launchers, not arbitrary
		// devices or unbounded binaries. Checking never executes the launcher.
		if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return false;
		accessSync(bin, constants.X_OK);
		return createHash("sha256").update(readFileSync(bin)).digest("hex") === digest.toLowerCase();
	} catch {
		return false;
	}
}

const RUNNER_GUIDANCE =
	"Use an installed repository-capable runner: --runner codex, --runner claude, or --runner opencode.";

// Shared by real reviews and previews. No model calls, subprocesses, network,
// cache writes, or auth probing. Both small and large pipelines need repo tools
// (the small path's critic must re-open producer/consumer code too).
export function preflightReview(
	docsOnlyFastPath: boolean,
	opts: RunnerOptions = {},
): ReviewPreflight {
	if (docsOnlyFastPath) return { status: "not_required", requiredCapability: "none" };
	let runner: RunnerName;
	try {
		runner = resolveRunner(opts);
	} catch (error) {
		return {
			status: "unsupported",
			requiredCapability: "repositoryRead",
			capability: "unknown",
			code: "runner_unavailable",
			message: `${error instanceof Error ? error.message : String(error)}\nNo model calls were made.`,
		};
	}
	const capability = REPOSITORY_CAPABILITY[runner];
	const declared = runner === "acp" && hasAcpRepositoryDeclaration();
	if (capability === "repositoryRead" || declared) {
		return {
			status: "ready",
			requiredCapability: "repositoryRead",
			runner,
			capability: "repositoryRead",
			capabilitySource: declared ? "operator_declared" : "adapter",
		};
	}
	const reason = capability === "promptOnly"
		? "This AI connection can only read supplied text, not the project files needed for review and critic verification."
		: "The selected ACP launcher's repository-read capability is unknown; protocol initialization is not tool verification.";
	return {
		status: "unsupported",
		requiredCapability: "repositoryRead",
		runner,
		capability,
		code: "unsupported_runner_capability",
		message: `Unsupported runner capability: ${reason} No model calls were made. ${RUNNER_GUIDANCE} (runner=${runner}; required=repositoryRead; available=${capability})`,
	};
}
