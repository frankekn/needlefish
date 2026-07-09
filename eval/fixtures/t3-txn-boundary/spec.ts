import type { FixtureSpec } from "../../shared/types";

// Difficulty: the refactor looks like pure extract-method, but the balance
// update moves OUTSIDE the transaction context manager. On a crash between
// the two writes, ledger and balance diverge — partial state, no syntax hint.
const spec: FixtureSpec = {
  id: "t3-txn-boundary",
  kind: "positive",
  tier: 3,
  defectClass: "write-moved-outside-transaction",
  description:
    "transfer() refactor extracts _apply(); the ledger insert stays inside `with db.transaction()` but the balance update now runs after the with-block exits. A crash between them corrupts balances.",
  baseFiles: {
    "app/transfer.py": `def transfer(db, from_acct, to_acct, cents):
    if cents <= 0:
        raise ValueError("amount must be positive")
    with db.transaction():
        db.execute(
            "INSERT INTO ledger (src, dst, cents) VALUES (?, ?, ?)",
            (from_acct, to_acct, cents),
        )
        db.execute(
            "UPDATE accounts SET balance = balance - ? WHERE id = ?",
            (cents, from_acct),
        )
        db.execute(
            "UPDATE accounts SET balance = balance + ? WHERE id = ?",
            (cents, to_acct),
        )
    return {"ok": True}
`,
  },
  headFiles: {
    "app/transfer.py": `def _record_ledger(db, from_acct, to_acct, cents):
    db.execute(
        "INSERT INTO ledger (src, dst, cents) VALUES (?, ?, ?)",
        (from_acct, to_acct, cents),
    )


def _apply_balances(db, from_acct, to_acct, cents):
    db.execute(
        "UPDATE accounts SET balance = balance - ? WHERE id = ?",
        (cents, from_acct),
    )
    db.execute(
        "UPDATE accounts SET balance = balance + ? WHERE id = ?",
        (cents, to_acct),
    )


def transfer(db, from_acct, to_acct, cents):
    if cents <= 0:
        raise ValueError("amount must be positive")
    with db.transaction():
        _record_ledger(db, from_acct, to_acct, cents)
    _apply_balances(db, from_acct, to_acct, cents)
    return {"ok": True}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "transaction|atomic|outside.{0,24}(with|txn|transaction)|partial.{0,16}(state|write|update)|rollback|not.{0,12}atomic|after.{0,20}(commit|transaction)|diverge|inconsistent.{0,16}balance" },
    ],
    anchorFile: "app/transfer.py",
    anchorLineRange: [18, 24],
  },
};

export default spec;
