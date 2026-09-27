# Finding confidence contract
Confidence measures verified evidence, independently of severity (impact).
- P0/P1/P2 findings require confidence >= 0.70; lower values are rejected by the validator.
- 0.90-1.00: changed line and failing consumer/path verified directly.
- 0.70-0.89: changed line verified and failure path strongly established.
- Do not inflate confidence to satisfy the threshold or relabel a potential serious defect as P3 merely because evidence is missing. P3 describes minor impact, not uncertainty.
- If missing evidence prevents a material verdict, state exactly what is missing in `residual_risks` with `blocks:true`. Do not turn a speculative concern into a finding. A critic may preserve candidate residual risks but must not invent new ones.
Before returning, check the severity/confidence pair of every finding. An empty findings array is valid; example numbers are not evidence.
