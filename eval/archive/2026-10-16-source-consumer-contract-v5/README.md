# Retired unpublished source-consumer contract v5

The v5 code-span delta passed local P2 review. A separate local probe found that code spans around the numeric multiplier still failed. Exact v5 bytes remain in spec.ts.txt, SHA-256 6735fb114f46b62a435e2bc6a5c25e4172a8afb25b69291ae370fb1aafd38700. spec.json preserves full source and expected data. Its catalog hash is 059d3dfb5ff6b362.

The final v6 delta permits code-span delimiters around the existing numeric multiplier literals. It adds no semantic vocabulary, relation, or scorer normalization. Tests compare plain, single-backtick, and double-backtick identifiers, calls, and numeric literals. This deterministic matcher does not cover arbitrary natural-language phrasing or every Markdown construction. No model eval or historical rescore occurs. Class R is NOT_RUN.

Delivery uses holdout-source-consumer-contract-v6 with the same causal relations and code-span support for identifiers, calls, and multiplier literals. The active catalog remains 99 fixtures/20 holdouts, fixtureSetHash d8e70a48a2f0d93d. Sealed v6 spec SHA-256 is 8e02a04cf7ccb1f8575ea7341b9bd552e4e6bdfe8bb7c5d40e0de8da2390d49f.
