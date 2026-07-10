import assert from "node:assert/strict";
import test from "node:test";
import { applyVerdictLabel, VERDICT_LABELS } from "./github";

test("applyVerdictLabel creates a missing label, removes alternatives, and adds the verdict", async () => {
	const calls: string[][] = [];
	const ghFn = (args: readonly string[]): unknown => {
		calls.push([...args]);
		if (args[1] === `repos/acme/widget/labels/${VERDICT_LABELS.pass}`) {
			throw new Error("HTTP 404: Not Found");
		}
		if (
			args.includes(
				`repos/acme/widget/issues/17/labels/${VERDICT_LABELS.needs_human}`,
			)
		) {
			throw new Error("HTTP 404: Not Found");
		}
		return {};
	};

	await applyVerdictLabel("acme/widget", 17, "pass", ghFn);

	assert.ok(
		calls.some(
			(args) =>
				args.includes("repos/acme/widget/labels") &&
				args.includes(`name=${VERDICT_LABELS.pass}`) &&
				args.includes("color=0e8a16") &&
				args.includes("description=Needlefish review verdict"),
		),
		"creates the current label after a 404",
	);
	assert.ok(
		calls.some((args) =>
			args.includes(
				`repos/acme/widget/issues/17/labels/${VERDICT_LABELS.changes_requested}`,
			),
		),
		"removes changes-requested",
	);
	assert.ok(
		calls.some((args) =>
			args.includes(
				`repos/acme/widget/issues/17/labels/${VERDICT_LABELS.needs_human}`,
			),
		),
		"attempts to remove needs-human and ignores its 404",
	);
	assert.ok(
		calls.some(
			(args) =>
				args.includes("repos/acme/widget/issues/17/labels") &&
				args.includes(`labels[]=${VERDICT_LABELS.pass}`),
		),
		"adds the pass label to the PR",
	);
});

test("applyVerdictLabel never propagates gh failures", async () => {
	const originalWrite = process.stderr.write;
	let warning = "";
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		warning += String(chunk);
		return true;
	}) as typeof process.stderr.write;

	try {
		await assert.doesNotReject(
			applyVerdictLabel("acme/widget", 18, "needs_human", () => {
				throw new Error("Resource not accessible by integration");
			}),
		);
	} finally {
		process.stderr.write = originalWrite;
	}

	assert.match(warning, /could not apply verdict label/);
});
