import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	lstatSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
	spawnRunnerProcess,
	type RunnerProcessResult,
} from "./runner-process.js";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const KIRO_QUERY =
	"Follow the complete review instructions in your agent prompt and return only the requested output.";

export interface KiroInvocation {
	readonly prompt: string;
	readonly repoPath: string;
	readonly model: string | undefined;
	readonly reasoningEffort: string | undefined;
	readonly timeoutMs: number;
	readonly env: NodeJS.ProcessEnv;
	readonly tmp: string;
	readonly expectJson: boolean;
}

export interface KiroResult {
	readonly res: RunnerProcessResult;
	readonly out: string;
}

export function prepareKiroEnvironment(
	env: NodeJS.ProcessEnv,
	tmp: string,
): NodeJS.ProcessEnv {
	const home = path.join(tmp, "kiro-home");
	mkdirSync(path.join(home, "settings"), {
		recursive: true,
		mode: PRIVATE_DIR_MODE,
	});
	writeKiroSettings(home);
	const isolated = {
		...env,
		KIRO_HOME: home,
		KIRO_NO_AUTO_UPDATE: "1",
		KIRO_CHAT_LOG_FILE: path.join(tmp, "kiro.log"),
		KIRO_LOG_NO_COLOR: "1",
	};
	if (process.env.NEEDLEFISH_EPHEMERAL_HOME !== "1") return isolated;
	const dataDir = path.join(tmp, "kiro-data");
	mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	if (!env.KIRO_API_KEY?.trim()) stageAuthDatabase(env, tmp);
	return { ...isolated, KIRO_DATA_DIR: dataDir };
}

export async function runKiro(
	invocation: KiroInvocation,
): Promise<KiroResult> {
	const agentName = `needlefish-${randomUUID()}`;
	const promptPath = path.join(invocation.tmp, "kiro-prompt.md");
	const cwd = path.join(invocation.tmp, "kiro-cwd");
	const prompt = [
		`Review repository root (use absolute paths for read/grep): ${invocation.repoPath}`,
		invocation.prompt,
	].join("\n\n");
	writeFileSync(promptPath, prompt, { mode: PRIVATE_FILE_MODE });
	mkdirSync(cwd, { recursive: true, mode: PRIVATE_DIR_MODE });
	writeKiroAgent(invocation.env, agentName, promptPath);
	const res = await spawnRunnerProcess({
		command: invocation.env.KIRO_BIN ?? "kiro-cli",
		args: kiroArgs(invocation, agentName),
		stdin: "",
		repoPath: cwd,
		timeoutMs: invocation.timeoutMs,
		env: invocation.env,
	});
	return {
		res,
		out: normalizeKiroOutput(res.stdout ?? "", invocation.expectJson),
	};
}

function writeKiroSettings(home: string): void {
	const settings = {
		"app.disableAutoupdates": true,
		"chat.disableInheritingDefaultResources": true,
	};
	writeFileSync(
		path.join(home, "settings", "cli.json"),
		JSON.stringify(settings),
		{ mode: PRIVATE_FILE_MODE },
	);
}

function stageAuthDatabase(env: NodeJS.ProcessEnv, tmp: string): void {
	const source = process.env.NEEDLEFISH_KIRO_AUTH_DB?.trim();
	if (!source) {
		throw new Error(
			"NEEDLEFISH_KIRO_AUTH_DB is required for guarded Kiro runs without a nonempty KIRO_API_KEY",
		);
	}
	try {
		if (!lstatSync(source).isFile()) throw new Error("not a regular file");
		accessSync(source, constants.R_OK);
	} catch (error) {
		throw new Error(
			`NEEDLEFISH_KIRO_AUTH_DB must be a regular readable file: ${source}`,
			{ cause: error },
		);
	}
	const home = env.HOME?.trim();
	const resolvedHome = home ? path.resolve(home) : "";
	const resolvedTmp = path.resolve(tmp);
	if (
		!resolvedHome ||
		(resolvedHome !== resolvedTmp &&
			!resolvedHome.startsWith(resolvedTmp + path.sep))
	) {
		throw new Error("guarded Kiro auth staging requires a disposable HOME");
	}
	const dataDir = path.join(resolvedHome, ".local", "share", "kiro-cli");
	mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	const destination = path.join(dataDir, "data.sqlite3");
	copyFileSync(source, destination);
	chmodSync(destination, PRIVATE_FILE_MODE);
}

function writeKiroAgent(
	env: NodeJS.ProcessEnv,
	agentName: string,
	promptPath: string,
): void {
	const home = env.KIRO_HOME;
	if (!home) throw new Error("Kiro runner requires an isolated KIRO_HOME");
	const agentsDir = path.join(home, "agents");
	mkdirSync(agentsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	const agent = {
		name: agentName,
		description: "Needlefish read-only review runner",
		tools: ["read", "grep"],
		allowedTools: ["read", "grep"],
		resources: [],
		prompt: pathToFileURL(promptPath).href,
	};
	writeFileSync(path.join(agentsDir, `${agentName}.json`), JSON.stringify(agent), {
		mode: PRIVATE_FILE_MODE,
	});
}

function kiroArgs(
	invocation: KiroInvocation,
	agentName: string,
): string[] {
	const args = [
		"chat",
		"--no-interactive",
		"--wrap",
		"never",
		"--agent",
		agentName,
		"--trust-tools=read,grep",
	];
	if (invocation.model) args.push("--model", invocation.model);
	if (invocation.reasoningEffort)
		args.push("--effort", invocation.reasoningEffort);
	args.push(KIRO_QUERY);
	return args;
}

function normalizeKiroOutput(output: string, expectJson: boolean): string {
	const normalized = stripVTControlCharacters(output)
		.replace(/\r\n?/g, "\n")
		.trim();
	if (!expectJson) return normalized;
	return finalJsonObject(normalized) ?? normalized;
}

function finalJsonObject(text: string): string | undefined {
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	let finalObject: string | undefined;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (depth === 0) {
			if (char === "{") {
				start = index;
				depth = 1;
			}
			continue;
		}
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}") depth--;
		if (depth !== 0 || start < 0) continue;
		const candidate = text.slice(start, index + 1);
		const trailing = text.slice(index + 1).trim();
		try {
			JSON.parse(candidate);
			if (trailing === "" || trailing === "```") finalObject = candidate;
		} catch {
			// Keep scanning: Kiro tool traces use non-JSON brace blocks.
		}
		start = -1;
	}
	return finalObject;
}
