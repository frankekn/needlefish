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
