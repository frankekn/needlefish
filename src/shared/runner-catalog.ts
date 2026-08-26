import { readFileSync } from "node:fs";
import { RUNNERS, type RunnerName } from "./runner.js";

export interface HostedRunnerInstall {
	readonly npmPackage: string;
	readonly defaultVersion: string;
	readonly testedPlatforms: readonly string[];
}

export interface RunnerCatalogEntry {
	readonly kind: "cli" | "http";
	readonly binary: string | null;
	readonly binaryEnv: string | null;
	readonly autoDetectOrder: number | null;
	readonly hostedInstall: HostedRunnerInstall | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, label: string): string | null {
	if (value === null) return null;
	if (typeof value === "string" && value.length > 0) return value;
	throw new Error(`${label} must be a non-empty string or null`);
}

function parseHostedInstall(value: unknown, runner: RunnerName): HostedRunnerInstall | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new Error(`runner catalog hostedInstall must be an object: ${runner}`);
	const npmPackage = nullableString(value.npmPackage, `${runner}.hostedInstall.npmPackage`);
	const defaultVersion = nullableString(value.defaultVersion, `${runner}.hostedInstall.defaultVersion`);
	if (npmPackage === null || defaultVersion === null) {
		throw new Error(`runner catalog hosted install fields cannot be null: ${runner}`);
	}
	if (
		!Array.isArray(value.testedPlatforms) ||
		value.testedPlatforms.some((platform) => typeof platform !== "string")
	) {
		throw new Error(`runner catalog testedPlatforms must be strings: ${runner}`);
	}
	return { npmPackage, defaultVersion, testedPlatforms: value.testedPlatforms };
}

function parseEntry(value: unknown, runner: RunnerName): RunnerCatalogEntry {
	if (!isRecord(value)) throw new Error(`runner catalog entry must be an object: ${runner}`);
	if (value.kind !== "cli" && value.kind !== "http") {
		throw new Error(`runner catalog kind must be cli or http: ${runner}`);
	}
	const binary = nullableString(value.binary, `${runner}.binary`);
	const binaryEnv = nullableString(value.binaryEnv, `${runner}.binaryEnv`);
	const autoDetectOrder = value.autoDetectOrder;
	if (autoDetectOrder !== null && (!Number.isInteger(autoDetectOrder) || Number(autoDetectOrder) <= 0)) {
		throw new Error(`runner catalog autoDetectOrder must be positive or null: ${runner}`);
	}
	if (value.kind === "http" && (binary !== null || binaryEnv !== null)) {
		throw new Error(`HTTP runner cannot declare a process binary: ${runner}`);
	}
	return {
		kind: value.kind,
		binary,
		binaryEnv,
		autoDetectOrder: autoDetectOrder === null ? null : Number(autoDetectOrder),
		hostedInstall: parseHostedInstall(value.hostedInstall, runner),
	};
}

function loadCatalog(): Readonly<Record<RunnerName, RunnerCatalogEntry>> {
	const raw: unknown = JSON.parse(
		readFileSync(new URL("../../runner-catalog.json", import.meta.url), "utf8"),
	);
	if (!isRecord(raw)) throw new Error("runner catalog must be an object");
	const expected = new Set<string>(RUNNERS);
	for (const key of Object.keys(raw)) {
		if (!expected.has(key)) throw new Error(`runner catalog contains unknown runner: ${key}`);
	}
	return Object.fromEntries(
		RUNNERS.map((runner) => {
			if (!(runner in raw)) throw new Error(`runner catalog is missing runner: ${runner}`);
			return [runner, parseEntry(raw[runner], runner)];
		}),
	) as Record<RunnerName, RunnerCatalogEntry>;
}

export const RUNNER_CATALOG = loadCatalog();

export const AUTO_DETECT_RUNNERS = [...RUNNERS]
	.filter((runner) => RUNNER_CATALOG[runner].autoDetectOrder !== null)
	.sort(
		(a, b) =>
			(RUNNER_CATALOG[a].autoDetectOrder ?? 0) -
			(RUNNER_CATALOG[b].autoDetectOrder ?? 0),
	);

export function defaultRunnerBinary(runner: RunnerName): string {
	const binary = RUNNER_CATALOG[runner].binary;
	if (!binary) throw new Error(`${runner} does not have a default process binary`);
	return binary;
}
