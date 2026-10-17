# Retired unpublished source-consumer contract v2

The sealed v2 draft was retired during local code review, before any model eval or delivery. Exact spec bytes are preserved in spec.ts.txt, SHA-256 ad06cf3caf0761f7450ae4de0f0736843bed4d343d0ab26afec7770edb819505. spec.json preserves the complete fixture for replay. Its catalog hash was bc70103b4880dabb. The active replacement is holdout-source-consumer-contract-v3.

## Gold fact contract before v3 implementation

The producer fact requires pageSize to scale the configured item count by 1000. Independently, the consumer fact requires the allocator to use that returned value directly as the array element count. Mentioning the allocator, logging its value, or repeating the producer magnitude does not establish array sizing. A direct new Array(pageSize(...)) expression establishes the consumer fact. Prose that explicitly passes or consumes pageSize as the array count also establishes it.

Tests cover absent allocator evidence, logging-only use, producer-only scaling, and the complete producer-to-array-count cause. Numeric magnitude cannot substitute for the consumer fact. These requirements come from the original authored source and bug description. The review counterexample is a synthetic local code-review case, not a captured eval answer. No historical results are changed or rescored. Class R remains NOT_RUN.

The final active replacement is holdout-source-consumer-contract-v3. The unpublished v2 failed local code review and is also archived. Active catalog 99 fixtures/20 holdouts has fixtureSetHash 301339b698973a5c. Sealed v3 spec SHA-256 is b90cba592a982d5a72d3a23bd8360c85bff425024a68e6dbb7e81ccb24bcb9f5. No model eval was run for either version.

Current active replacement is holdout-source-consumer-contract-v4. v3 also failed local relation-contract review and is archived without model sampling. The final catalog remains 99 fixtures/20 holdouts, fixtureSetHash 69ca169e54cab80d. Sealed v4 spec SHA-256 is d699dea60fb663a76c701ac4cfc9945e4f0d9de517b6bdb73b6ff83f28770fe6.

The final active replacement is holdout-source-consumer-contract-v5, whose only change from v4 is Markdown code-span tolerance. The catalog remains 99 fixtures/20 holdouts, fixtureSetHash 059d3dfb5ff6b362. Sealed v5 spec SHA-256 is 6735fb114f46b62a435e2bc6a5c25e4172a8afb25b69291ae370fb1aafd38700.

Delivery uses holdout-source-consumer-contract-v6 with the same causal relations and code-span support for identifiers, calls, and multiplier literals. The active catalog remains 99 fixtures/20 holdouts, fixtureSetHash d8e70a48a2f0d93d. Sealed v6 spec SHA-256 is 8e02a04cf7ccb1f8575ea7341b9bd552e4e6bdfe8bb7c5d40e0de8da2390d49f.
