# Phase 2 Tier-1 fixture preregistration

Authored on 2026-10-16 before implementation or model calls, against main `7e5c4738eeac71c87be1766b3bb30fb82fc4706f`. This file records the oracle from the application contracts. No captured model answer or historical score informed the selection or patterns.

Eight synthetic positives extend the seven existing Tier-1 families to `3+2+2+2+2+2+2`. Each family receives one sealed holdout. The eighth fixture covers registry credentials because direct credential disclosure affects every consumer of the source, independent of measured lane performance. These are synthetic scenarios, not eight independent historical PRs. No real credential appears in these fixtures.

| Fixture ID | Family | Language | Contract and deliberate head defect | Head anchor | Expected severity |
| --- | --- | --- | --- | --- | --- |
| holdout-t1-smtp-password | hardcoded-credential | Python | Mail delivery authenticates with the operator-provisioned SMTP_PASSWORD. Head replaces the environment lookup with a shared password literal, exposing the deployment credential to source readers and ignoring rotation. | mailer.py:4 | P1 |
| t1-registry-token-variation | hardcoded-credential | JavaScript | Package upload uses the operator-provisioned REGISTRY_TOKEN. Head embeds the publish token in the authorization header, exposing write authority and ignoring rotation. | registry.mjs:2 | P1 |
| holdout-t1-inverted-export-guard | inverted-permission-check | JavaScript | Only accounts with canExport may obtain private archive data. Head negates the permission check, releasing data to unauthorized accounts and rejecting authorized accounts. | archive.mjs:2 | P1 |
| holdout-t1-missing-profile-guard | removed-none-guard | Python | A missing customer profile produces anonymous labeling. Head removes the None branch, so ordinary missing lookups crash while present profiles still work. | labels.py:2 | P1 |
| holdout-t1-swallowed-settlement-error | error-swallow-payment-path | JavaScript | Settlement success is reported only after the payment processor succeeds. Head turns the rejected debit into a successful settled response. | settlement.mjs:6 | P1 |
| holdout-t1-node-permission-flag | missing-security-flag | POSIX shell | The script runner allows the supplied script to read itself, but forbids all other files using Node permission mode. Head drops the permission flags, allowing a script to read a private sibling file. | run-script.sh:3 | P1 |
| holdout-t1-untrusted-auditor-ref | untrusted-self-review-tool-checkout | POSIX shell and Python | The audit entrypoint comes from the independently pinned trusted ref. Head loads the auditor from the proposal ref, allowing an author to replace the validator with unconditional approval. | audit.sh:3 | P1 |
| holdout-t1-plugin-write-token | subprocess-inherits-write-token | Python | An extension receives ordinary environment configuration, but never the parent service's write token. Head stops supplying the filtered environment, exposing the write token to the extension process. | extension.py:7 | P1 |

P1 is an authored severity expectation for independent review, not a new scoring field. Each new expected finding requires its exact file and changed line. Missing-profile severity follows the declared request contract where absent profiles are ordinary inputs, and each request fails after this deletion.

## Verification contract

Execute both base and head with the same controlled input. Assert correct base output and the exact head failure or unauthorized effect. Use fake credentials and local files only. For permission containment, execute the real installed Node permission runtime. For auditor provenance, create a local Git repository with distinct trusted and proposal commits and execute the selected Python auditor. The tests do not contact any provider or run an eval model.

Use the existing loadFixture to verify real generated patch anchors. Check the catalog contains 101 fixtures, 15 Tier-1 positives, the exact seven-family counts, and seven new sealed holdouts. The existing 93 spec files remain byte-identical. Do not rewrite historical reports, README scores, prompts, matcher, scorer, qualification policy, or calibration tools.

The holdouts remain excluded from prompt iteration with `--holdout exclude`. No prompt iteration is authorized here. The full Class R model gate is **NOT_RUN**. Fixture-plan readiness does not qualify a lane, select production floors, or complete issue #123.
