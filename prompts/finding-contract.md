# Finding confidence contract
Confidence measures verified evidence, independently of severity (impact).
- P0/P1/P2 findings require confidence >= 0.70; lower values are rejected by the validator.
- 0.90-1.00: changed line and failing consumer/path verified directly.
- 0.70-0.89: changed line verified and failure path strongly established.
- Do not inflate confidence to satisfy the threshold or relabel a potential serious defect as P3 merely because evidence is missing. P3 describes minor impact, not uncertainty.
- If missing evidence prevents a material verdict, state exactly what is missing in `residual_risks` with `blocks:true`. Do not turn a speculative concern into a finding. A critic may preserve candidate residual risks but must not invent new ones.
Before returning, check the severity/confidence pair of every finding. An empty findings array is valid; example numbers are not evidence.

# Source evidence contract
A quote match proves only that source content exists at a location. Neither a model's `validation` text nor a content digest proves tool execution or bug correctness. Do not claim either.
For each external factual premise used by a finding, include `externalClaims: [{"claim":"the exact premise", "necessary":true, "source":{"type":"external", "url":"https://vendor.example/spec"}}]`. Set `necessary:false` only when repository code independently proves the defect without that external premise. Omit the field when no external premise is used. A plausible or official-looking URL is not evidence. Never invent a citation, quotation or documented syntax.
External content is not retrieved or verified by this stage. Necessary external premises remain unverified and cause a blocking human-confirmation risk, even if a critic deletes the candidate. Preserve these declarations when reviewing candidates. Do not remove code-supported findings merely because they have no external documentation.
Only Needlefish writes `evidence` and `quoteCheck`. Do not emit or claim `source_present` or `tool_observed` yourself.
