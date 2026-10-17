import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runManagedRunnerProcess } from "../../src/shared/runner-process";
import { pairedSchedule } from "./deep-concurrency";
import { executionIdentity, executeStudy, parseAdmission, pairedTimingSummary } from "./deep-concurrency-execute";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function setup(t: { after: (fn: () => void) => void }, scenario: string) {
	const directory = mkdtempSync(path.join(tmpdir(), "needlefish-paired-proof-"));
	const previous = { ...process.env };
	for (const key of Object.keys(process.env)) if (/PROXY|OPENAI_BASE_URL|NEEDLEFISH_.*CONNECTION|CODEX_PUBLIC/.test(key)) delete process.env[key];
	process.env.PATH = `${path.dirname(process.execPath)}:${process.env.PATH}`;
	process.env.NEEDLEFISH_NO_RETRY = "1";
	const native = path.join(directory, "native.cjs");
	writeFileSync(native, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
if (process.argv.includes('--version')) { process.stdout.write('offline-native 1.0\\n'); process.exit(0); }
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
 const scenario=${JSON.stringify(scenario)};
 const repo=JSON.parse(/^The repository to inspect is ("[^\\n]+")./.exec(input)[1]);
 const log=${JSON.stringify(path.join(directory, "events.jsonl"))};
 const emit=x=>fs.appendFileSync(log,JSON.stringify({...x,pid:process.pid})+'\\n');
 const out=process.argv[process.argv.indexOf('--output-last-message')+1];
 const answer=x=>fs.writeFileSync(out,JSON.stringify(x));
 const changed=cp.execFileSync('git',['--no-optional-locks','-C',repo,'diff','--name-only','HEAD~1','HEAD'],{encoding:'utf8'}).trim().split('\\n');
 const campaign=${JSON.stringify(path.join(directory, "campaign"))};
 const activeSlot=fs.readdirSync(campaign).filter(x=>/-r\\d+-c[37]$/.test(x)).find(x=>!fs.existsSync(path.join(campaign,x,'supervisor-terminal.json')));
 if(input.includes('review-MAP pass')){
  emit({kind:'map'});
  if(scenario==='invalid') { fs.writeFileSync(out,'not JSON'); return; }
  if(scenario==='rate-limit') { process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'HTTP 429 Too Many Requests',status_code:429}})+'\\n'); process.stderr.write('HTTP 429 Too Many Requests'); process.exitCode=1; return; }
  if(scenario==='timeout'||scenario==='cancel'||scenario==='drift'||scenario==='lost-evidence') { emit({kind:'stuck'}); setTimeout(()=>{},60000); return; }
  answer({summary:'mapped',hotspots:(scenario==='underfill' ? [] : scenario==='mismatch'&&activeSlot.endsWith('c7') ? changed.slice(1,7) : changed.slice(0,6)).map((file,i)=>({name:'h'+i,files:[file],why:'changed',risk:'high',edges:[]}))});
 }else if(input.includes('doing a DEEP review')){
  const hotspot=JSON.parse(input.split('# Hotspot (this surface)\\n')[1].split('\\n# Refs\\n')[0]);
  const name=hotspot.name;
  emit({kind:'start',name});
  const arm=scenario==='underfill'?1:Number(/c([37])$/.exec(activeSlot)[1]);
  const deadline=Date.now()+5000;
  const wait=()=>{
   const events=fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse);
   const map=events.map(x=>x.kind).lastIndexOf('map');
   const current=events.slice(map+1);
   if(current.filter(x=>x.kind==='start').length<arm && Date.now()<deadline){setTimeout(wait,10);return;}
   emit({kind:'end',name});
   if(scenario==='partial'&&name==='h0'){fs.writeFileSync(out,'invalid');return;}
   answer({summary:'checked',findings:[],checked:['FILES inspected='+JSON.stringify(hotspot.files)],residual_risks:scenario==='needs-human'?[{text:'Manual premise requires verification',blocks:true}]:[]});
  }; wait();
 }else if(input.includes('adversarial critic')){
  emit({kind:'critic'});
  answer({summary:'checked',decisions:[],checked:['all files'],residual_risks:scenario==='needs-human'?[{text:'Manual premise requires verification',blocks:true}]:[]});
 }else{throw new Error('unexpected prompt');}
});
`);
	chmodSync(native, 0o700);
	const identity = executionIdentity();
	writeFileSync(path.join(directory, "arm"), "3");
	const admission = parseAdmission({ protocol: "issue193-deep-concurrency-v3", operatorApproved: true, exclusiveCapacity: true,
		sourceCommit: identity.sourceCommit, projectionSha256: identity.projectionSha256, nodeSha256: identity.nodeSha256,
		command: native, commandSha256: hash(readFileSync(native)), runnerVersion: "offline-native 1.0", lane: "fake-offline" });
	t.after(() => {
		const evidence = process.env.NEEDLEFISH_PAIRED_TEST_EVIDENCE_DIR;
		if (evidence && existsSync(path.join(directory,"campaign"))) {
			mkdirSync(evidence, { recursive: true });
			const target = path.join(evidence, scenario + "-final");
			cpSync(path.join(directory,"campaign"), target, { recursive: true });
			if (existsSync(path.join(directory,"events.jsonl"))) writeFileSync(path.join(target,"fake-events.jsonl"), readFileSync(path.join(directory,"events.jsonl")));
		}
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		rmSync(directory, { recursive: true, force: true });
	});
	return { directory, admission };
}

function retain(campaign: string, name: string) {
	const destination = process.env.NEEDLEFISH_PAIRED_TEST_EVIDENCE_DIR;
	if (destination) { mkdirSync(destination, { recursive: true }); cpSync(campaign, path.join(destination, name), { recursive: true }); }
}


test("executor drives all 24 registered reviews through production API with stable captured Git objects and 3/7 barriers", async t => {
	const { directory, admission } = setup(t, "complete");
	const campaign = path.join(directory, "campaign");
	writeFileSync(path.join(directory, "arm"), "3");
	const report = await executeStudy({ directory: campaign, admission });
	assert.equal(report.stop, null, JSON.stringify(report));
	assert.deepEqual(report.slots.map(slot => slot.outcome), Array(24).fill("COMPLETED"));
	assert.deepEqual(report.arms.map(arm => [arm.planned, arm.started, arm.completed, arm.nativeAttempted, arm.nativeEnded, arm.nativeDrained]), [[12,12,12,108,108,108],[12,12,12,108,108,108]]);
	for (const slot of report.slots) {
		const evidence: unknown = JSON.parse(readFileSync(path.join(campaign, slot.slot, "attempt-index.json"), "utf8"));
		assert.ok(Array.isArray(evidence));
		assert.equal(evidence.length, 9);
		const identities = evidence.map((attempt: unknown) => { assert.ok(attempt && typeof attempt === "object" && "start" in attempt); return attempt.start; });
		for (const identity of identities) {
			assert.ok(identity && typeof identity === "object" && "headTree" in identity && "head" in identity);
			const snapshot = JSON.parse(readFileSync(path.join(campaign, `${slot.fixtureId}.snapshot.json`), "utf8"));
			assert.equal(identity.headTree, snapshot.identity.headTree);
			assert.equal(identity.head, snapshot.identity.head);
		}
	}
	const events: Array<{kind:string;name:string}> = readFileSync(path.join(directory, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	let active = 0, maximum = 0, started = 0, ended = 0, reviewIndex = -1;
	for (const event of events) {
		if (event.kind === "map") { reviewIndex++; active = 0; maximum = 0; started = 0; ended = 0; }
		if (event.kind === "start") { active++; started++; maximum = Math.max(active, maximum); }
		if (event.kind === "end") { active--; ended++; }
		if (event.kind === "critic") assert.deepEqual({active, maximum, started, ended}, {active:0, maximum:report.slots[reviewIndex].deepConcurrency, started:7, ended:7});
	}
	assert.equal(reviewIndex, 23);
	retain(campaign, "full24");
	t.diagnostic(JSON.stringify({planned:24, completed:24, nativeAttempts:216, barrierMaximum:[3,7], providerCalls:0}));
});

test("underfill stops only after completed whole review and preserves denominator and all native attempts", async t => {
	const { directory, admission } = setup(t, "underfill");
	writeFileSync(path.join(directory, "arm"), "1");
	const report = await executeStudy({ directory: path.join(directory, "campaign"), admission });
	assert.equal(report.stop, "WORKLOAD_UNDERFILLED");
	assert.deepEqual(report.slots.map(slot => slot.outcome), ["WORKLOAD_UNDERFILLED", ...Array(23).fill("NOT_STARTED_EARLY_STOP")]);
	assert.deepEqual(report.arms.map(arm => [arm.planned, arm.started, arm.completed]), [[12,1,0],[12,0,0]]);
	const terminal = JSON.parse(readFileSync(path.join(directory, "campaign", report.slots[0].slot, "terminal.json"), "utf8"));
	assert.equal(terminal.result.verdict, "pass");
	assert.equal(terminal.deep.done, 1);
	const attempts = JSON.parse(readFileSync(path.join(directory, "campaign", report.slots[0].slot, "attempt-index.json"), "utf8"));
	assert.deepEqual(attempts.map((attempt: {start:{kind:string}}) => attempt.start.kind).sort(), ["critic","deep","map"]);
	retain(path.join(directory,"campaign"), "underfill");
});

test("admission rejects absent authorization, identity drift, unsupported route and reused output", async t => {
	const { directory, admission } = setup(t, "underfill");
	assert.throws(() => parseAdmission({...admission,operatorApproved:false}));
	assert.throws(() => parseAdmission({...admission,lane:"proxy"}));
	await assert.rejects(executeStudy({directory:path.join(directory,"never"),admission:{...admission,projectionSha256:"0".repeat(64)}}), /projectionSha256 drift/);
	assert.equal(existsSync(path.join(directory,"never")), false);
	mkdirSync(path.join(directory,"existing"));
	await assert.rejects(executeStudy({directory:path.join(directory,"existing"),admission}), /EEXIST/);
});

for (const [scenario, expected] of [["rate-limit", "ERROR"], ["invalid", "ERROR"], ["timeout", "TIMEOUT"], ["partial", "PARTIAL"], ["needs-human", "COMPLETED"]] as const) {
	test(`retains ${scenario} and continues without a replacement whole review`, async t => {
		const { directory, admission } = setup(t, scenario);
		process.env.NEEDLEFISH_TIMEOUT_MS = scenario === "timeout" ? "1200" : "10000";
		process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS = "30000";
		const campaign = path.join(directory, "campaign");
		const cancellation = new AbortController();
		const poll = setInterval(() => {
			const reportPath = path.join(campaign, "report.json");
			if (existsSync(reportPath) && JSON.parse(readFileSync(reportPath, "utf8")).slots[0].elapsedMs !== null) cancellation.abort();
		}, 10);
		let report;
		try { report = await executeStudy({ directory: campaign, admission, cancelSignal: cancellation.signal }); }
		finally { clearInterval(poll); }
		assert.equal(report.slots[0].outcome, expected, JSON.stringify(report));
		assert.equal(report.slots.length, 24);
		assert.deepEqual(report.slots.slice(2).map(slot => slot.outcome), Array(22).fill("NOT_STARTED_EARLY_STOP"));
		assert.equal(report.stop, "CANCELLED");
		const attempts = JSON.parse(readFileSync(path.join(campaign, report.slots[0].slot, "attempt-index.json"), "utf8"));
		if (scenario === "rate-limit") assert.equal(attempts[0].provider429, "observed_structured_status_429");
		assert.equal(attempts.length, scenario === "invalid" ? 2 : scenario === "partial" ? 10 : scenario === "needs-human" ? 9 : 1);
		for (const attempt of attempts) { assert.ok(attempt.start.birth); assert.ok(attempt.end); }
		if (scenario === "needs-human" || scenario === "partial") assert.equal(report.arms[0].needsHuman, 1);
		retain(campaign, scenario);
	});
}

for (const scenario of ["cancel", "drift", "lost-evidence"] as const) {
	test(`${scenario} stops boundedly and retains all slots and owned process evidence`, async t => {
		const { directory, admission } = setup(t, scenario);
		const campaign = path.join(directory, "campaign");
		const cancellation = new AbortController();
		let triggered = false;
		const poll = setInterval(() => {
			if (triggered || !existsSync(path.join(directory, "events.jsonl"))) return;
			triggered = true;
			if (scenario === "cancel") cancellation.abort();
			else if (scenario === "lost-evidence") {
				const slot = path.join(campaign, "large-tail-boundary-bug-r1-c3", "attempts");
				for (const id of readdirSync(slot)) {
					rmSync(path.join(slot,id,"stdin.txt"), {force:true});
					const start = JSON.parse(readFileSync(path.join(slot,id,"start.json"), "utf8"));
					process.kill(-start.pgid, "SIGTERM");
				}
			} else {
				const snapshot = JSON.parse(readFileSync(path.join(campaign, "large-tail-boundary-bug.snapshot.json"), "utf8"));
				writeFileSync(path.join(snapshot.bundle.repoPath, snapshot.bundle.changedFiles[0].path), "captured baseline drift\n");
			}
		}, 10);
		const begin = performance.now();
		let report;
		try { report = await executeStudy({ directory: campaign, admission, cancelSignal: cancellation.signal }); }
		finally { clearInterval(poll); }
		assert.equal(triggered, true);
		assert.equal(report.stop, scenario === "cancel" ? "CANCELLED" : "METHOD_ERROR");
		assert.equal(report.slots[0].outcome, scenario === "cancel" ? "CANCELLED" : "METHOD_ERROR");
		assert.deepEqual(report.slots.slice(1).map(slot => slot.outcome), Array(23).fill("NOT_STARTED_EARLY_STOP"));
		assert.ok(performance.now() - begin < 10000, "bounded stop must not wait for native 60-second hold");
		retain(campaign, scenario);
	});
}

test("top-level execution CLI retains the underfilled artifact and returns nonzero", async t => {
	const { directory, admission } = setup(t, "underfill");
	writeFileSync(path.join(directory, "arm"), "1");
	const admissionFile = path.join(directory, "admission.json");
	writeFileSync(admissionFile, JSON.stringify(admission));
	const child = await runManagedRunnerProcess({ command: process.execPath,
		args: ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), path.resolve("eval/tools/deep-concurrency-execute.ts"), "--execute", admissionFile, path.join(directory, "campaign")],
		repoPath: process.cwd(), timeoutMs: 15000, env: process.env, onSpawn: controller => controller.endStdin() });
	assert.equal(child.status, 1, child.stderr);
	const report: unknown = JSON.parse(child.stdout);
	assert.ok(report && typeof report === "object" && "stop" in report && "slots" in report);
	assert.equal(report.stop, "WORKLOAD_UNDERFILLED");
	assert.ok(Array.isArray(report.slots));
	assert.equal(report.slots.length, 24);
	retain(path.join(directory,"campaign"), "cli-underfill");
});


test("paired workload changes stop after the second complete review without replacement draws", async t => {
	const { directory, admission } = setup(t, "mismatch");
	const report = await executeStudy({ directory: path.join(directory,"campaign"), admission });
	assert.equal(report.stop, "WORKLOAD_MISMATCH");
	assert.deepEqual(report.slots.slice(0,2).map(slot => slot.outcome), ["COMPLETED","COMPLETED"]);
	assert.deepEqual(report.slots.slice(2).map(slot => slot.outcome), Array(22).fill("NOT_STARTED_EARLY_STOP"));
	assert.equal(report.pairedReviewTimings.kind, "unavailable");
});

test("descriptive paired timings use monotonic review duration and exclude incomplete campaigns", () => {
	const slots = pairedSchedule().map(slot => ({...slot, outcome:"COMPLETED" as const, elapsedMs:999,
		detail:{terminal:{durationMs:slot.deepConcurrency===3?100:90}, workloadMismatch:false}}));
	const summary = pairedTimingSummary(slots);
	assert.equal(summary.kind, "descriptive_only");
	assert.equal(summary.medianMs, -10);
	assert.equal(summary.minimumMs, -10);
	assert.equal(summary.maximumMs, -10);
	assert.equal(summary.differences?.length, 12);
	assert.deepEqual(pairedTimingSummary(slots.slice(1)), {kind:"unavailable"});
});
