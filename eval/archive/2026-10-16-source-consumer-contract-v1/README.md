# Retired source-consumer contract v1

The original sealed v1 is retired from the active catalog. Its exact authored bytes remain in spec.ts.txt, SHA-256 e570b76f2237d36e59a4122bc846d46d0d54203e504139966326583b2fed728a. spec.json preserves the full original source trees and expected oracle for historical replay. No historical report is rescored.

The replacement has a new identity, holdout-source-consumer-contract-v2. It replaces v1 once in the active catalog; it does not add another weight for the same bug. The fixture-set hash must change.

## Gold bug contract, authored before v2 implementation

The original description and source establish both required facts. At src/page.ts:3, pageSize changes its item count to itemsPerPage * 1000. The unchanged src/allocate.ts passes pageSize(20) directly to new Array as the element count. This allocates 20,000 entries instead of 20. An external URL or a documentation mismatch alone proves neither the downstream use nor its consequence.

The v2 oracle requires independent facts for producer scaling and downstream array allocation with excessive element count. Both must be anchored to src/page.ts:3. A document-only finding mentioning 1000 must fail. A vague units finding without consumer evidence must fail. A finding connecting the multiplied return value to the allocator's element count must pass. These cases are authored from the bug contract without reading captured model output.

The replacement remains a sealed holdout. Model sampling and the Class R gate are NOT_RUN. Original 93-fixture scores and the issue 84 frozen study remain unchanged.

The active catalog remains 99 fixtures and 20 holdouts. Its fixtureSetHash changes from fe221b9d7b38c8a9 to bc70103b4880dabb. The sealed v2 spec SHA-256 is ad06cf3caf0761f7450ae4de0f0736843bed4d343d0ab26afec7770edb819505. Restoring the archived v1 object in place of v2 reproduces the prior catalog hash.

The final active replacement is holdout-source-consumer-contract-v3. The unpublished v2 failed local code review and is also archived. Active catalog 99 fixtures/20 holdouts has fixtureSetHash 301339b698973a5c. Sealed v3 spec SHA-256 is b90cba592a982d5a72d3a23bd8360c85bff425024a68e6dbb7e81ccb24bcb9f5. No model eval was run for either version.

Current active replacement is holdout-source-consumer-contract-v4. v3 also failed local relation-contract review and is archived without model sampling. The final catalog remains 99 fixtures/20 holdouts, fixtureSetHash 69ca169e54cab80d. Sealed v4 spec SHA-256 is d699dea60fb663a76c701ac4cfc9945e4f0d9de517b6bdb73b6ff83f28770fe6.

The final active replacement is holdout-source-consumer-contract-v5, whose only change from v4 is Markdown code-span tolerance. The catalog remains 99 fixtures/20 holdouts, fixtureSetHash 059d3dfb5ff6b362. Sealed v5 spec SHA-256 is 6735fb114f46b62a435e2bc6a5c25e4172a8afb25b69291ae370fb1aafd38700.

Delivery uses holdout-source-consumer-contract-v6 with the same causal relations and code-span support for identifiers, calls, and multiplier literals. The active catalog remains 99 fixtures/20 holdouts, fixtureSetHash d8e70a48a2f0d93d. Sealed v6 spec SHA-256 is 8e02a04cf7ccb1f8575ea7341b9bd552e4e6bdfe8bb7c5d40e0de8da2390d49f.
