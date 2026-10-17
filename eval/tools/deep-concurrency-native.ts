import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const config: unknown = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.ok(config && typeof config === "object" && "command" in config && typeof config.command === "string"
	&& "sha256" in config && typeof config.sha256 === "string" && "attempts" in config && typeof config.attempts === "string");
assert.equal(hash(readFileSync(config.command)), config.sha256, "native executable drift");
const command = config.command;
const commandSha256 = config.sha256;
const directory = path.join(config.attempts, randomUUID());
mkdirSync(directory, { mode: 0o700 });
const write = (file: string, value: unknown) => writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const started = process.hrtime.bigint();
const startedAt = new Date().toISOString();
const birth = (pid: number) => execFileSync("ps", ["-p", String(pid), "-o", "pid=,pgid=,lstart="], { encoding: "utf8" }).trim();
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => { input += chunk; });
process.stdin.on("end", () => {
	writeFileSync(path.join(directory, "stdin.txt"), input, { flag: "wx", mode: 0o600 });
	const repository = /^The repository to inspect is ("[^\n]+"). Your startup directory/m.exec(input);
	assert.ok(repository, "missing actual sandbox path");
	const repo: unknown = JSON.parse(repository[1]);
	assert.equal(typeof repo, "string");
	assert.ok(typeof repo === "string");
	const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], { encoding: "utf8" }).trimEnd();
	const base = git("rev-parse", "HEAD~1");
	const hotspotText = input.split("# Hotspot (this surface)\n")[1]?.split("\n# Refs\n")[0];
	const hotspot: unknown = hotspotText === undefined ? null : JSON.parse(hotspotText.trim());
	const policy = input.split("# AGENTS.md\n")[1]?.split("\n\n# Hotspot (this surface)")[0];
	const kind = hotspot ? "deep" : input.includes("review-MAP pass") ? "map" : input.includes("adversarial critic") ? "critic" : "unknown";
	const args = process.argv.slice(3);
	const nativeStarted = process.hrtime.bigint();
	const child = spawn(command, args, { cwd: process.cwd(), env: process.env, detached: false, stdio: ["pipe", "pipe", "pipe"] });
	assert.ok(child.pid);
	writeFileSync(path.join(directory, "stdout.txt"), "", { flag: "wx", mode: 0o600 });
	writeFileSync(path.join(directory, "stderr.txt"), "", { flag: "wx", mode: 0o600 });
	const wrapperBirth = birth(process.pid);
	const pgid = Number(wrapperBirth.split(/\s+/)[1]);
	write("start.json", { args, cwd: process.cwd(), pgid, id: path.basename(directory), kind, hotspot, pid: child.pid, birth: birth(child.pid),
		wrapperBirth, startedAt, monotonicStartNs: started.toString(), nativeMonotonicStartNs: nativeStarted.toString(), promptSha256: hash(input),
		baitSha256: hash(git("show", "HEAD:.needlefish/answers.json")), ...(policy === undefined ? {} : { policySha256: hash(policy) }),
		head: git("rev-parse", "HEAD"), headTree: git("rev-parse", "HEAD^{tree}"),
		base, baseTree: git("rev-parse", `${base}^{tree}`), patchSha256: hash(git("diff", base, "HEAD")),
		commandSha256 });
	child.stdout.on("data", (chunk: Buffer) => { appendFileSync(path.join(directory, "stdout.txt"), chunk, { mode: 0o600 }); process.stdout.write(chunk); });
	child.stderr.on("data", (chunk: Buffer) => { appendFileSync(path.join(directory, "stderr.txt"), chunk, { mode: 0o600 }); process.stderr.write(chunk); });
	let error: string | null = null;
	child.on("error", (cause) => { error = cause.message; });
	// Both processes stay in the core-owned group so its hard timeout also kills an uncooperative native child.
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { child.kill(signal); });
	child.stdin.on("error", () => {});
	child.stdin.end(input);
	child.on("close", (status, signal) => {
		const ended = process.hrtime.bigint();
		const last = args[args.indexOf("--output-last-message") + 1];
		let output: string | null = null;
		try { output = readFileSync(last, "utf8"); } catch { /* Native failure can leave no artifact. */ }
		write("end.json", { status, signal, error, endedAt: new Date().toISOString(), monotonicEndNs: ended.toString(),
			wrapperServiceMs: Number(ended - started) / 1e6, nativeServiceMs: Number(ended - nativeStarted) / 1e6, output });
		process.exitCode = status ?? 1;
	});
});
