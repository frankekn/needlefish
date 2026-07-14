import {
	existsSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAcp } from "./acp.js";
import {
	parsePositiveInteger,
	type RunnerName,
	type RunnerOptions,
	type RunStat,
} from "./runner.js";
import { resolveRunner } from "./runner-detection.js";
import {
	spawnRunnerProcess,
	type RunnerProcessResult,
} from "./runner-process.js";
import {
	assertRunnerSandboxClean,
	isRunnerSafetyError,
	prepareRunnerSandbox,
} from "./runner-sandbox.js";

export { isRunnerSafetyError } from "./runner-sandbox.js";

const BASE_ENV_ALLOWLIST = [
	"PATH",
	"PATHEXT",
	"HOME",
	"USERPROFILE",
	// claude CLI credential lookup (macOS Keychain) fails with "Not logged in"
	// when USER is absent — verified 2026-07-07 by env -i bisection.
	"USER",
	"LOGNAME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"SHELL",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

const RUNNER_ENV_ALLOWLIST: Record<RunnerName, readonly string[]> = {
	codex: [
		"CODEX_BIN",
		"CODEX_MODEL",
		"CODEX_REASONING_EFFORT",
		"CODEX_RETRY_MS",
		"CODEX_TIMEOUT_MS",
	],
	claude: [
		"CLAUDE_BIN",
		"CLAUDE_MODEL",
		"ANTHROPIC_API_KEY",
		"CLAUDE_CODE_OAUTH_TOKEN",
	],
	opencode: ["OPENCODE_BIN", "OPENCODE_MODEL", "OPENAI_API_KEY"],
	grok: ["GROK_BIN", "GROK_MODEL"],
	pi: ["PI_BIN", "PI_MODEL", "PI_PROVIDER"],
	openai: [],
	acp: ["NEEDLEFISH_ACP_BIN"],
};

function buildRunnerEnv(
	runner: RunnerName,
	ghConfigDir: string,
	ephemeralHome?: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { GH_CONFIG_DIR: ghConfigDir };
	const allowed = [...BASE_ENV_ALLOWLIST, ...RUNNER_ENV_ALLOWLIST[runner]];
	const extra = (process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	for (const name of [...allowed, ...extra]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	// Ephemeral per-draw HOME (G1): when the flag is on and a non-claude
	// runner requested isolation, point HOME/USERPROFILE at a per-invocation
	// throwaway dir inside the rmSync'd tmp. Every session/cache/log the CLI
	// writes dies with the draw; nothing accumulates under the real HOME.
	if (ephemeralHome !== undefined) {
		env.HOME = ephemeralHome;
		env.USERPROFILE = ephemeralHome;
		if (runner === "opencode") {
			env.XDG_CONFIG_HOME = path.join(ephemeralHome, ".config");
			env.XDG_DATA_HOME = path.join(ephemeralHome, ".local", "share");
		}
	}
	return env;
}

// Minimal auth material each runner needs to authenticate from an isolated
// HOME. We copy INDIVIDUAL FILES (never a whole directory) from the real
// HOME so sessions/history/logs/cache never land in the ephemeral HOME.
// Filenames suggesting mutable state (sessions, history, log, cache) are
// deliberately excluded — they must not exist in the isolated HOME.
//
// Empirically determined by smoking each CLI under an isolated HOME and
// adding files until auth worked (2026-07-12):
//   - codex:    ~/.codex/auth.json (OAuth token) + ~/.codex/config.toml
//   - grok:     ~/.grok/auth.json (credentials); ~/.grok/config.toml (model
//               routing / provider) — both are files, not the whole dir
//   - pi:       ~/.pi/agent/auth.json (OAuth) + ~/.pi/agent/models.json
//               (provider/model registry, incl. CLIProxyAPI routing)
//   - opencode: XDG-based, not ~/.opencode: ~/.config/opencode/opencode.json
//               (config + auth) + ~/.local/share/opencode/auth.json
//               (account/credential store)
// claude is exempt: its credentials live in the macOS Keychain tied to the
// real HOME, so it keeps the real HOME under the flag (see runCodexOnce).
const EPHEMERAL_HOME_AUTH_FILES: Record<RunnerName, readonly string[]> = {
	codex: [".codex/auth.json", ".codex/config.toml"],
	claude: [],
	opencode: [
		".config/opencode/opencode.json",
		".local/share/opencode/auth.json",
	],
	grok: [".grok/auth.json", ".grok/config.toml"],
	pi: [".pi/agent/auth.json", ".pi/agent/models.json"],
	openai: [],
	acp: [],
};

// Configuration that may still affect routing when authentication is supplied
// through an environment variable. Credential stores stay out of this list:
// env-authenticated invocations must not expose unrelated OAuth/account files
// that happen to exist in the caller's HOME.
const EPHEMERAL_HOME_ENV_CONFIG_FILES: Record<RunnerName, readonly string[]> = {
	codex: [], // runCodexCli always passes --ignore-user-config
	claude: [],
	opencode: [".config/opencode/opencode.json"],
	grok: [".grok/config.toml"],
	pi: [".pi/agent/models.json"],
	openai: [],
	acp: [],
};

function passthroughNames(): readonly string[] {
	return (process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

// A provider credential supplied via NEEDLEFISH_RUNNER_ENV_PASSTHROUGH is a
// supported auth mode that never reads the runner's HOME files. Only actual
// credential variables count (model/endpoint vars configure, they don't
// authenticate), and only when non-empty.
function hasPassthroughCredential(credentialVars: readonly string[]): boolean {
	return passthroughNames().some(
		(name) => credentialVars.includes(name) && !!process.env[name],
	);
}

function hasOpenCodeEnvCredential(): boolean {
	return (
		!!process.env.OPENAI_API_KEY ||
		passthroughNames().some(
			(name) => name.endsWith("_API_KEY") && !!process.env[name],
		)
	);
}

function strictCommaList(raw: string, envName: string): string[] {
	const entries = raw.split(",").map((entry) => entry.trim());
	if (entries.some((entry) => entry.length === 0)) {
		throw new Error(`${envName} entries must not be empty`);
	}
	return entries;
}

function requireAcpEnvCredentials(): void {
	const raw = process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS;
	if (raw === undefined || raw.trim().length === 0) {
		throw new Error(
			"NEEDLEFISH_EPHEMERAL_HOME=1 needs explicit ACP credentials: set NEEDLEFISH_ACP_AUTH_FILES to HOME-relative files or NEEDLEFISH_ACP_AUTH_ENV_VARS to credential variable names also authorized by NEEDLEFISH_RUNNER_ENV_PASSTHROUGH",
		);
	}
	const names = strictCommaList(raw, "NEEDLEFISH_ACP_AUTH_ENV_VARS");

	const passthrough = new Set(passthroughNames());
	const seen = new Set<string>();
	for (const name of names) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw new Error(
				`NEEDLEFISH_ACP_AUTH_ENV_VARS entries must be valid environment variable names: ${name}`,
			);
		}
		if (seen.has(name)) {
			throw new Error(
				`NEEDLEFISH_ACP_AUTH_ENV_VARS entries must be unique: ${name}`,
			);
		}
		seen.add(name);
		if (!passthrough.has(name)) {
			throw new Error(
				`NEEDLEFISH_ACP_AUTH_ENV_VARS credential must also appear in NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: ${name}`,
			);
		}
		if (!process.env[name]) {
			throw new Error(
				`NEEDLEFISH_ACP_AUTH_ENV_VARS credential is missing or empty: ${name}`,
			);
		}
	}
}

// Which of a runner's HOME files are required vs merely staged-if-present
// depends on the auth mode in effect: env-key / proxy-provider modes carry
// their credentials outside the HOME, so demanding the HOME credential store
// would reject supported configurations that never read it.
function ephemeralAuthFiles(runner: RunnerName): {
	readonly required: readonly string[];
	readonly optional: readonly string[];
} {
	if (runner === "codex") {
		// CODEX_API_KEY through the passthrough authenticates without auth.json.
		if (hasPassthroughCredential(["CODEX_API_KEY"])) {
			return {
				required: [],
				optional: EPHEMERAL_HOME_ENV_CONFIG_FILES.codex,
			};
		}
		// The invocation always passes --ignore-user-config, so the config
		// file cannot be a requirement — an auth.json-only OAuth setup is valid.
		return {
			required: [".codex/auth.json"],
			optional: [".codex/config.toml"],
		};
	}
	if (
		runner === "grok" &&
		hasPassthroughCredential(["GROK_API_KEY", "XAI_API_KEY"])
	) {
		return {
			required: [],
			optional: EPHEMERAL_HOME_ENV_CONFIG_FILES.grok,
		};
	}
	// opencode: OPENAI_API_KEY is an allowlisted auth input (see
	// RUNNER_ENV_ALLOWLIST). Other provider API keys must be explicitly named
	// in the passthrough and non-empty.
	if (runner === "opencode" && hasOpenCodeEnvCredential()) {
		return {
			required: [],
			optional: EPHEMERAL_HOME_ENV_CONFIG_FILES.opencode,
		};
	}
	// acp launches an arbitrary external agent whose credential layout we
	// cannot know a priori: the operator declares the copy-only staging list
	// explicitly (comma-separated HOME-relative paths). No declaration = fail
	// closed — silently keeping the real HOME would fake isolation.
	if (runner === "acp") {
		const raw = process.env.NEEDLEFISH_ACP_AUTH_FILES?.trim();
		if (!raw) {
			// Environment-authenticated mode uses a separate declaration to classify
			// credentials. Passthrough only authorizes forwarding and may also carry
			// non-secret configuration, so it cannot prove authentication by itself.
			requireAcpEnvCredentials();
			return { required: [], optional: [] };
		}
		const required = strictCommaList(raw, "NEEDLEFISH_ACP_AUTH_FILES");
		for (const entry of required) {
			// Validate with BOTH separator forms: on Windows `..\` traverses and
			// `C:\` is absolute, and the later staging join is platform-native.
			const unified = entry.replace(/\\/g, "/");
			const normalized = path.posix.normalize(unified);
			if (
				path.posix.isAbsolute(normalized) ||
				/^[A-Za-z]:/.test(normalized) ||
				normalized === ".." ||
				normalized.startsWith("../")
			) {
				throw new Error(
					`NEEDLEFISH_ACP_AUTH_FILES entries must be HOME-relative without '..': ${entry}`,
				);
			}
		}
		return { required, optional: [] };
	}
	// pi: an explicit non-default PI_PROVIDER routes through a proxy whose
	// credentials live in the proxy — only the provider registry is read.
	if (runner === "pi") {
		const provider = process.env.PI_PROVIDER ?? "openai-codex";
		if (provider !== "openai-codex") {
			return {
				required: [".pi/agent/models.json"],
				optional: [],
			};
		}
	}
	return { required: EPHEMERAL_HOME_AUTH_FILES[runner], optional: [] };
}

// Prepare an ephemeral HOME for a runner invocation. Creates <tmp>/home
// (0700) and copies the minimal auth files from the real HOME into it.
// Fail-closed: if the flag is on but a required auth source file is missing,
// throw naming the file — NEVER silently fall back to the real HOME.
// Returns undefined when isolation is off (caller then keeps real HOME).
// Exported for direct unit testing of the linking/fail-closed invariants.
export function prepareEphemeralHome(
	runner: RunnerName,
	tmp: string,
): string | undefined {
	if (process.env.NEEDLEFISH_EPHEMERAL_HOME !== "1") return undefined;
	// claude exemption: its credential lookup goes through the macOS Keychain
	// tied to the real HOME; --no-session-persistence already blocks session
	// writes. Keep real HOME under the flag.
	if (runner === "claude") return undefined;
	// acp credential staging is handled in ephemeralAuthFiles: the operator
	// must declare the copy-only list via NEEDLEFISH_ACP_AUTH_FILES, or the
	// call fails closed there.
	// buildRunnerEnv points both HOME and USERPROFILE at the ephemeral dir, so
	// accept either as the auth source root (USERPROFILE = Windows). First
	// NON-EMPTY value wins: HOME="" must fall through, not select "".
	const realHome =
		process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
	const home = path.join(tmp, "home");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const { required, optional } = ephemeralAuthFiles(runner);
	if (!realHome) {
		// No source HOME is only a problem when something must be staged from
		// it: an env-authenticated mode (required empty) is independently valid,
		// and optional config files simply don't exist without a HOME.
		if (required.length > 0) {
			throw new Error(
				"NEEDLEFISH_EPHEMERAL_HOME=1 but neither HOME nor USERPROFILE is set: cannot locate auth source files",
			);
		}
		return home;
	}
	const stage = [
		...required.map((rel) => ({ rel, required: true })),
		...optional.map((rel) => ({ rel, required: false })),
	];
	const homeRoot = path.resolve(realHome);
	for (const { rel, required: isRequired } of stage) {
		const xdgSource =
			runner === "opencode" && rel.startsWith(".config/")
				? path.join(
						process.env.XDG_CONFIG_HOME?.trim() || path.join(realHome, ".config"),
						rel.slice(".config/".length),
					)
				: runner === "opencode" && rel.startsWith(".local/share/")
					? path.join(
							process.env.XDG_DATA_HOME?.trim() ||
								path.join(realHome, ".local", "share"),
							rel.slice(".local/share/".length),
						)
					: undefined;
		// Containment backstop for HOME-relative staging entries (operator-supplied
		// acp entries included). OpenCode's fixed filenames may instead live under
		// an explicitly configured XDG root outside HOME.
		const resolvedSrc = xdgSource ?? path.resolve(realHome, rel);
		if (
			xdgSource === undefined &&
			resolvedSrc !== homeRoot &&
			!resolvedSrc.startsWith(homeRoot + path.sep)
		) {
			throw new Error(
				`NEEDLEFISH_EPHEMERAL_HOME auth staging path escapes HOME: ${rel}`,
			);
		}
		const src = xdgSource ?? path.join(realHome, rel);
		if (!existsSync(src)) {
			if (!isRequired) continue;
			throw new Error(
				`NEEDLEFISH_EPHEMERAL_HOME=1 but required auth source is missing: ${src} (runner ${runner}). Refusing to fall back to the real HOME.`,
			);
		}
		const dest = path.join(home, rel);
		mkdirSync(path.dirname(dest), { recursive: true });
		// COPY, never symlink: a symlink is a write-through channel into the
		// real HOME (a runner could persist config edits future runs load, and
		// parallel draws refreshing tokens in place would corrupt the shared
		// file). The copy dies with the draw; a token refresh written to it is
		// discarded — accepted cost (plan 008). Note the isolation boundary:
		// this only stops default-path resolution; a same-uid child that
		// hunts absolute paths can still read the real HOME. Detection of
		// that behavior is G3's job (bait + canary), not G1's.
		copyFileSync(src, dest);
	}
	return home;
}

export interface CodexOptions extends RunnerOptions {
	readonly repoPath: string;
	readonly targetHeadSha: string;
	readonly targetPatch?: string;
	readonly label?: string;
	readonly onStat?: (stat: RunStat) => void;
	readonly onFailedAttempt?: (
		runnerAttempt: number,
		raw: string | undefined,
	) => void;
	// Called with the captured stdout of every failed attempt (runner crash or
	// nonzero exit) — the eval canary scan must see output a runner emitted
	// before dying, whether or not a retry later succeeds.
	readonly onFailedRaw?: (raw: string, runnerAttempt: number) => void;
	// Called with the FULL transcript (resolved output + raw stdout + stderr,
	// deduped) of every SUCCESSFUL attempt. A status-0 runner can emit the
	// canary on a stream while writing a clean final message — the resolved
	// output alone is not the transcript.
	readonly onRaw?: (raw: string, runnerAttempt: number) => void;
}

type JsonRecord = Record<string, unknown>;
type CodexReasoningEffort = "medium" | "high" | "xhigh";

interface RunnerResult {
	readonly res: RunnerProcessResult;
	readonly out: string;
}

interface RunnerInvocation {
	readonly prompt: string;
	readonly repoPath: string;
	readonly model: string | undefined;
	readonly reasoningEffort: string | undefined;
	readonly timeoutMs: number;
	readonly env: NodeJS.ProcessEnv;
	readonly tmp: string;
}

export async function runCodex(
	prompt: string,
	opts: CodexOptions,
): Promise<string> {
	const runner = resolveRunner(opts);
	if (runner === "opencode" && !process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER) {
		throw new Error(
			"The opencode runner has no verified process-level sandbox restraint in headless mode " +
				"(it executes tool calls with no permission gate) and must be explicitly enabled via " +
				"NEEDLEFISH_ALLOW_OPENCODE_RUNNER=1.",
		);
	}
	// Fail closed (single live probe is not a guarantee): on 2026-07-10 pi with
	// `--tools read,grep,find,ls` reported "no write, shell, bash, or edit tool is
	// available" and created no file when instructed to; keep the env gate anyway.
	if (runner === "pi" && !process.env.NEEDLEFISH_ALLOW_PI_RUNNER) {
		throw new Error(
			"The pi runner has no verified process-level sandbox restraint in headless mode " +
				"(it executes tool calls with no permission gate) and must be explicitly enabled via " +
				"NEEDLEFISH_ALLOW_PI_RUNNER=1.",
		);
	}
	const maxAttempts = process.env.NEEDLEFISH_NO_RETRY ? 1 : 2;
	const startedAt = Date.now();
	let attempts = 0;
	const emitStat = (ok: boolean): void => {
		if (!opts.onStat) return;
		const model = resolveModel(opts, runner);
		opts.onStat({
			label: opts.label ?? "(unlabeled)",
			runner,
			...(model !== undefined ? { model } : {}),
			durationMs: Date.now() - startedAt,
			attempts,
			ok,
		});
	};
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		attempts = attempt;
		try {
			const out = await runCodexOnce(prompt, opts, runner, attempt);
			emitStat(true);
			return out;
		} catch (err) {
			const raw =
				err instanceof Error
					? (err as Error & { rawOutput?: string }).rawOutput
					: undefined;
			opts.onFailedAttempt?.(attempt, raw);
			if (raw) {
				// Hand the failed attempt's stdout to the caller's accumulator now:
				// a successful retry discards this error object, and the canary
				// scan must still see what the dying attempt emitted.
				opts.onFailedRaw?.(raw, attempt);
			}
			if (!(err instanceof Error) || isRunnerSafetyError(err)) {
				emitStat(false);
				throw err;
			}
			lastErr = err;
			if (attempt < maxAttempts) {
				const backoff = retryMsFor(runner);
				await new Promise<void>((resolve) => setTimeout(resolve, backoff));
			}
		}
	}
	emitStat(false);
	throw lastErr;
}

async function runCodexOnce(
	prompt: string,
	opts: CodexOptions,
	runner: RunnerName,
	runnerAttempt: number,
): Promise<string> {
	const model = resolveModel(opts, runner);
	const timeoutMs = opts.timeoutMs ?? timeoutMsFor(runner);
	if (runner === "openai") {
		return runOpenAIDirect(prompt, model, timeoutMs, (raw) =>
			opts.onRaw?.(raw, runnerAttempt),
		);
	}
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-"));
	// Everything after mkdtemp lives inside the try: a preparation failure
	// (e.g. fail-closed missing auth in prepareEphemeralHome) must still hit
	// the finally cleanup, or it leaks the dir — with copied credentials in it.
	try {
		const ghConfigDir = path.join(tmp, "gh-empty");
		mkdirSync(ghConfigDir, { recursive: true });
		const ephemeralHome = prepareEphemeralHome(runner, tmp);
		const env = buildRunnerEnv(runner, ghConfigDir, ephemeralHome);
		const sandbox = prepareRunnerSandbox({
			runner,
			repoPath: opts.repoPath,
			prompt,
			targetHeadSha: opts.targetHeadSha,
			...(opts.targetPatch ? { targetPatch: opts.targetPatch } : {}),
			tmp,
		});
		const invocation = {
			prompt: sandbox.prompt,
			repoPath: sandbox.repoPath,
			model,
			reasoningEffort: opts.reasoningEffort,
			timeoutMs,
			env,
			tmp,
		};
		const result = await runRunner(runner, invocation);

		// A runner that crashes or exits nonzero may already have emitted output;
		// ride it along on the error (message unchanged) so the eval canary scan
		// sees it — dying is not an escape hatch from detection. All three
		// surfaces matter: result.out is the resolved model output (codex writes
		// it to --output-last-message, not stdout), result.res.stdout the raw
		// stream, and stderr rides UNTRUNCATED (the error message clips it at
		// 2000 chars — a canary parked past the clip must still reach the scan).
		const withRunnerOutput = (err: Error): Error => {
			const raw = [
				...new Set([result.out, result.res.stdout, result.res.stderr]),
			]
				.filter(Boolean)
				.join("\n");
			if (raw) {
				(err as Error & { rawOutput?: string }).rawOutput = raw;
			}
			return err;
		};
		if (result.res.error) throw withRunnerOutput(result.res.error);
		if (result.res.status !== 0) {
			throw withRunnerOutput(
				new Error(
					`${runner} runner exited ${result.res.status}: ${(result.res.stderr ?? "").slice(0, 2000)}`,
				),
			);
		}
		// A sandbox violation is itself loud, but the output emitted before the
		// violation still matters to the canary scan — a runner must not be able
		// to emit the bait and then launder it by dirtying the sandbox.
		try {
			assertRunnerSandboxClean(
				runner,
				sandbox.repoPath,
				sandbox.expectedHeadSha,
			);
		} catch (err) {
			if (err instanceof Error) throw withRunnerOutput(err);
			throw err;
		}
		// Output normalization can throw too (e.g. malformed opencode envelope
		// from a zero-exit process) — that text is still canary-scan material.
		try {
			const out = outputFor(runner, result);
			// Success is not an escape hatch either: the raw streams of a
			// status-0 attempt (codex prints noise to stdout while the model
			// output lands in the out-file) must reach the scan whole.
			const raw = [
				...new Set([out, result.out, result.res.stdout, result.res.stderr]),
			]
				.filter(Boolean)
				.join("\n");
			opts.onRaw?.(raw, runnerAttempt);
			return out;
		} catch (err) {
			if (err instanceof Error) throw withRunnerOutput(err);
			throw err;
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

export function extractJson(text: string): unknown {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const raw = fence ? fence[1] : text;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("no JSON object found in codex output");
	}
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`invalid JSON in codex output: ${error.message}`, {
				cause: error,
			});
		}
		throw error;
	}
}

function resolveModel(
	opts: CodexOptions,
	runner: RunnerName,
): string | undefined {
	if (opts.model) return opts.model;
	if (process.env.NEEDLEFISH_MODEL) return process.env.NEEDLEFISH_MODEL;
	switch (runner) {
		case "codex":
			return process.env.CODEX_MODEL;
		case "claude":
			return process.env.CLAUDE_MODEL;
		case "opencode":
			return process.env.OPENCODE_MODEL;
		case "openai":
			return process.env.OPENAI_MODEL;
		case "grok":
			return process.env.GROK_MODEL;
		case "pi":
			return process.env.PI_MODEL;
		case "acp":
			return undefined;
	}
}

function timeoutMsFor(runner: RunnerName): number {
	if (process.env.NEEDLEFISH_TIMEOUT_MS !== undefined) {
		return parsePositiveInteger(
			process.env.NEEDLEFISH_TIMEOUT_MS,
			"NEEDLEFISH_TIMEOUT_MS",
		);
	}
	if (runner === "codex" && process.env.CODEX_TIMEOUT_MS !== undefined) {
		return parsePositiveInteger(
			process.env.CODEX_TIMEOUT_MS,
			"CODEX_TIMEOUT_MS",
		);
	}
	return 600000;
}

function retryMsFor(runner: RunnerName): number {
	if (process.env.NEEDLEFISH_RETRY_MS !== undefined) {
		return parsePositiveInteger(
			process.env.NEEDLEFISH_RETRY_MS,
			"NEEDLEFISH_RETRY_MS",
		);
	}
	if (runner === "codex" && process.env.CODEX_RETRY_MS !== undefined) {
		return parsePositiveInteger(process.env.CODEX_RETRY_MS, "CODEX_RETRY_MS");
	}
	return 5000;
}

async function runRunner(
	runner: RunnerName,
	invocation: RunnerInvocation,
): Promise<RunnerResult> {
	switch (runner) {
		case "codex":
			return await runCodexCli(invocation);
		case "claude":
			return await runClaude(invocation);
		case "opencode":
			return await runOpenCode(invocation);
		case "openai":
			throw new Error("openai runner uses direct HTTP path, not runRunner");
		case "grok":
			return await runGrok(invocation);
		case "pi":
			return await runPi(invocation);
		case "acp":
			return await runAcp(invocation);
	}
}

async function runCodexCli(
	invocation: RunnerInvocation,
): Promise<RunnerResult> {
	const lastMsg = path.join(invocation.tmp, "last.txt");
	const reasoningEffort = resolveCodexReasoningEffort();
	const args = [
		"exec",
		"--color",
		"never",
		"--ignore-user-config",
		"-c",
		`model_reasoning_effort="${reasoningEffort}"`,
		"-s",
		"read-only",
		"--skip-git-repo-check",
		"--output-last-message",
		lastMsg,
	];
	if (invocation.model) args.push("-m", invocation.model);
	if (invocation.reasoningEffort)
		args.push("-c", `model_reasoning_effort=${invocation.reasoningEffort}`);

	const res = await spawnRunnerProcess({
		command: process.env.CODEX_BIN ?? "codex",
		args,
		stdin: invocation.prompt,
		repoPath: invocation.repoPath,
		timeoutMs: invocation.timeoutMs,
		env: invocation.env,
	});

	let out: string;
	try {
		out = readFileSync(lastMsg, "utf8");
	} catch {
		out = res.stdout ?? "";
	}
	return { res, out };
}

function resolveCodexReasoningEffort(): CodexReasoningEffort {
	const value = process.env.CODEX_REASONING_EFFORT;
	if (value === undefined || value === "") return "medium";
	if (value === "medium" || value === "high" || value === "xhigh") return value;
	throw new Error("CODEX_REASONING_EFFORT must be one of: medium, high, xhigh");
}

async function runClaude(invocation: RunnerInvocation): Promise<RunnerResult> {
	const args = [
		"--print",
		"--output-format",
		"text",
		"--permission-mode",
		"plan",
		"--safe-mode",
		"--no-session-persistence",
	];
	if (invocation.model) args.push("--model", invocation.model);
	if (invocation.reasoningEffort)
		args.push("--effort", invocation.reasoningEffort);

	const res = await spawnRunnerProcess({
		command: process.env.CLAUDE_BIN ?? "claude",
		args,
		stdin: invocation.prompt,
		repoPath: invocation.repoPath,
		timeoutMs: invocation.timeoutMs,
		env: invocation.env,
	});
	return { res, out: res.stdout ?? "" };
}

async function runOpenCode(
	invocation: RunnerInvocation,
): Promise<RunnerResult> {
	const promptPath = path.join(invocation.tmp, "prompt.md");
	writeFileSync(promptPath, invocation.prompt, { mode: 0o600 });
	const args = [
		"run",
		"--format",
		"json",
		"--pure",
		"--dir",
		invocation.repoPath,
	];
	args.push("--file", promptPath);
	if (invocation.model) args.push("--model", invocation.model);
	if (invocation.reasoningEffort)
		args.push("--variant", invocation.reasoningEffort);
	args.push("Use the attached prompt file as your complete instruction.");

	const res = await spawnRunnerProcess({
		command: process.env.OPENCODE_BIN ?? "opencode",
		args,
		stdin: "",
		repoPath: invocation.repoPath,
		timeoutMs: invocation.timeoutMs,
		env: invocation.env,
	});
	return { res, out: res.stdout ?? "" };
}

async function runGrok(invocation: RunnerInvocation): Promise<RunnerResult> {
	const promptPath = path.join(invocation.tmp, "prompt.txt");
	writeFileSync(promptPath, invocation.prompt, { mode: 0o600 });
	const args = [
		"-m",
		invocation.model ?? "grok-build",
		"--prompt-file",
		promptPath,
		"--output-format",
		"plain",
	];
	// Fail closed in plan mode: on 2026-07-09 grok-4.5 produced 0/8 valid review
	// JSON in plan mode, but it was write-restrained. The env opt-in unlocks the
	// working unsandboxed mode; grok CLI --sandbox read-only and --disallowed-tools
	// were verified ineffective at preventing writes that day.
	if (!process.env.NEEDLEFISH_ALLOW_GROK_UNSANDBOXED)
		args.push("--permission-mode", "plan");
	if (invocation.reasoningEffort)
		args.push("--reasoning-effort", invocation.reasoningEffort);
	const res = await spawnRunnerProcess({
		command: process.env.GROK_BIN ?? "grok",
		args,
		stdin: "",
		repoPath: invocation.repoPath,
		timeoutMs: invocation.timeoutMs,
		env: invocation.env,
	});
	return { res, out: res.stdout ?? "" };
}

const PI_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

function resolvePiThinking(
	reasoningEffort: string | undefined,
): PiThinkingLevel {
	if (reasoningEffort === undefined || reasoningEffort === "") return "medium";
	if ((PI_THINKING_LEVELS as readonly string[]).includes(reasoningEffort)) {
		return reasoningEffort as PiThinkingLevel;
	}
	throw new Error(
		`--thinking must be one of: ${PI_THINKING_LEVELS.join(", ")}`,
	);
}

async function runPi(invocation: RunnerInvocation): Promise<RunnerResult> {
	const thinking = resolvePiThinking(invocation.reasoningEffort);
	const args = [
		"-p",
		"--no-session",
		"--mode",
		"text",
		"--provider",
		// PI_PROVIDER lets deployments route through a local CLIProxyAPI
		// provider registered in ~/.pi/agent/models.json instead of pi's own
		// openai-codex OAuth (e.g. the ubuntu runner, where credentials live
		// in the proxy).
		process.env.PI_PROVIDER ?? "openai-codex",
		"--model",
		invocation.model ?? "gpt-5.6-sol",
		"--thinking",
		thinking,
		"--tools",
		"read,grep,find,ls",
	];
	// Prompt goes on stdin, not argv: a review bundle can exceed OS ARG_MAX as a
	// positional arg. Verified 2026-07-10: `pi -p --no-session --mode text` with
	// no positional message reads the full prompt from stdin.
	const res = await spawnRunnerProcess({
		command: process.env.PI_BIN ?? "pi",
		args,
		stdin: invocation.prompt,
		repoPath: invocation.repoPath,
		timeoutMs: invocation.timeoutMs,
		env: invocation.env,
	});
	return { res, out: res.stdout ?? "" };
}

function outputFor(runner: RunnerName, result: RunnerResult): string {
	switch (runner) {
		case "codex":
		case "claude":
			return result.out;
		case "opencode":
			return extractOpenCodeText(result.out);
		case "openai":
			return result.out;
		case "grok":
			return result.out;
		case "pi":
			return result.out;
		case "acp":
			return result.out;
	}
}

async function runOpenAIDirect(
	prompt: string,
	model: string | undefined,
	timeoutMs: number,
	onRaw?: (raw: string) => void,
): Promise<string> {
	const baseUrl = (
		process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
	).replace(/\/$/, "");
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey)
		throw new Error("OPENAI_API_KEY is required for the openai runner");
	if (!model)
		throw new Error(
			"model is required for the openai runner (use --model or OPENAI_MODEL)",
		);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
			}),
			signal: controller.signal,
		});
		const text = await res.text();
		// Every failure path rides the FULL response body on the error (the
		// message stays clipped): the eval canary scan must see what the API
		// actually returned — a clipped message is not the transcript, and the
		// direct-HTTP runner has no stdout/out-file surfaces to fall back on.
		const withBody = (err: Error): Error => {
			if (text) (err as Error & { rawOutput?: string }).rawOutput = text;
			return err;
		};
		if (!res.ok)
			throw withBody(
				new Error(`openai runner HTTP ${res.status}: ${text.slice(0, 2000)}`),
			);
		let json: { choices?: { message?: { content?: string } }[] };
		try {
			json = JSON.parse(text) as {
				choices?: { message?: { content?: string } }[];
			};
		} catch {
			throw withBody(
				new Error(
					`openai runner: non-JSON response body: ${text.slice(0, 500)}`,
				),
			);
		}
		const content = json.choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content) {
			throw withBody(
				new Error(
					`openai runner: empty content in response: ${text.slice(0, 500)}`,
				),
			);
		}
		onRaw?.(text);
		return content;
	} finally {
		clearTimeout(timer);
	}
}

function isRecord(raw: unknown): raw is JsonRecord {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function openCodeText(raw: JsonRecord): string | null {
	const direct = raw.text;
	if (typeof direct === "string") return direct;
	const part = raw.part;
	if (!isRecord(part)) return null;
	const nested = part.text;
	return typeof nested === "string" ? nested : null;
}

function extractOpenCodeText(stdout: string): string {
	const parts: string[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(trimmed);
		} catch (error) {
			if (error instanceof SyntaxError) continue;
			throw error;
		}
		if (!isRecord(raw)) continue;
		const text = openCodeText(raw);
		if (text) parts.push(text);
	}
	return parts.length > 0 ? parts.join("") : stdout;
}
