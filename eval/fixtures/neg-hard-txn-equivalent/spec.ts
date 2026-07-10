import type { FixtureSpec } from "../../shared/types";

// HOLDOUT: sealed at authoring time (round 2, 2026-07-09).
// Hard negative, deliberately the mirror image of t3-txn-boundary: the same
// extract-method refactor shape, but BOTH helpers stay inside the with-block.
// The FP bait is pattern-matching "extracted write + transaction" to the
// positive fixture's defect without reading the indentation.
const spec: FixtureSpec = {
  id: "neg-hard-txn-equivalent",
  kind: "negative",
  holdout: true,
  defectClass: "safe-transaction-refactor",
  description:
    "record() refactor extracts _insert_event and _bump_counter; both calls remain inside `with db.transaction()`. Atomicity unchanged.",
  baseFiles: {
    "app/audit.py": `def record(db, actor, action):
    if not actor:
        raise ValueError("actor required")
    with db.transaction():
        db.execute(
            "INSERT INTO events (actor, action) VALUES (?, ?)",
            (actor, action),
        )
        db.execute(
            "UPDATE counters SET n = n + 1 WHERE name = 'events'",
        )
    return True
`,
  },
  headFiles: {
    "app/audit.py": `def _insert_event(db, actor, action):
    db.execute(
        "INSERT INTO events (actor, action) VALUES (?, ?)",
        (actor, action),
    )


def _bump_counter(db):
    db.execute(
        "UPDATE counters SET n = n + 1 WHERE name = 'events'",
    )


def record(db, actor, action):
    if not actor:
        raise ValueError("actor required")
    with db.transaction():
        _insert_event(db, actor, action)
        _bump_counter(db)
    return True
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
