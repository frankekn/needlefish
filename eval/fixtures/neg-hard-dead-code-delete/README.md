# Closed-application contract

The original fixture leaves external package consumers and public API promises unspecified.
Go exports alone do not establish either promise.
The owner chose the closed-application interpretation for issue #84.

The revised fixture commits the same `AGENTS.md` in base and head.
The contract states that all packages serve this application, there are no external package consumers,
and exported identifiers carry no public API or compatibility promise.
It does not prescribe a review verdict or prohibit findings.
The Go files, removal patch, expected result, and holdout status stay unchanged.

The fixture keeps its existing ID. `fixtureSetHash` already includes base and head file contents,
so the contract creates a new catalog identity without adding a duplicate to the denominator.
At main `7e5c4738eeac71c87be1766b3bb30fb82fc4706f`, both catalogs contain 93 fixtures and 17 holdouts.

| Identity | Original | Revised |
| --- | --- | --- |
| Full catalog | `74c7943ce025fbb6` | `5884011a9cfd9413` |
| This fixture alone | `1ead560c33c0daeb` | `c9be7debeba6f3cd` |

This is a Class R model-input change. The revised model gate is **NOT_RUN**.
A new full gate must use the revised catalog and the applicable holdout and draw requirements.
Old reports and scores remain immutable. Their catalog identity differs from the revised catalog,
so they cannot serve as a direct `--compare`, `--resume`, or baseline substitute for this version.
In-flight runs retain their original source and catalog.
This contract change does not establish model drift or finish the issue #84 time-window study.

`eval/shared/dead-code-fixture.test.ts` builds the real fixture, checks both committed policies,
and verifies that `bundle.agentsMd` contains the contract while the patch still contains only Go deletions.
Run it with `node --test --import tsx eval/shared/dead-code-fixture.test.ts`.
