import assert from "node:assert/strict";
import test from "node:test";
import { envFlagOn } from "./env.js";

test("envFlagOn accepts only the string 1", (t) => {
	const name = "NEEDLEFISH_TEST_BOOLEAN_FLAG";
	const previous = process.env[name];
	t.after(() => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	});

	for (const value of ["1", "0", "", "true", "yes"] as const) {
		process.env[name] = value;
		assert.equal(envFlagOn(name), value === "1", `value ${JSON.stringify(value)}`);
	}
	delete process.env[name];
	assert.equal(envFlagOn(name), false, "unset flag");
});
