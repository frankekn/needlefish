import assert from "node:assert/strict";
import test from "node:test";
import { loadPrompt } from "./prompts.js";

for (const name of ["review.md", "deep.md", "critic.md"] as const) {
  test(`${name} supplies the confidence admission contract`, () => {
    const prompt = loadPrompt(name);
    assert.match(prompt, /P0\/P1\/P2.*0\.70/);
    assert.match(prompt, /Do not inflate confidence/);
    assert.match(prompt, /residual_risks/);
    assert.doesNotMatch(prompt, /"confidence": 0\.0/);
    assert.doesNotMatch(prompt, /\{\{FINDING_CONTRACT\}\}/);
  });
}

for (const name of ["review.md", "deep.md"] as const) {
  test(`${name} exposes declared external premises in the finding output shape`, () => {
    const prompt = loadPrompt(name);
    const outputShape = prompt.slice(prompt.indexOf("Return ONLY"));
    assert.match(outputShape, /"externalClaims": \[\s*\{\s*"claim": "[^"]+",\s*"necessary": true,\s*"source": \{ "type": "external", "url": "https:\/\/[^" ]+" \}\s*\}\s*\]/);
    assert.match(prompt, /Omit the field when no external premise is used/);
  });
}


test("critic emits a total decision ledger without rewriting findings", () => {
  const prompt = loadPrompt("critic.md");
  assert.match(prompt, /exactly one decision for every ref/);
  assert.match(prompt, /"action":"keep","severity":"P2","confidence":0.90/);
  assert.match(prompt, /"action":"drop"/);
  assert.match(prompt, /correct severity and confidence in either direction/);
  assert.match(prompt, /For review\/deep output, for each external factual premise/);
  assert.match(prompt, /preserves those original candidate fields through its decisions/);
  assert.doesNotMatch(prompt, /SAME shape|ONLY job is to PRUNE|return an empty findings array/);
});
