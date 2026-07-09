import type { FixtureSpec } from "../../shared/types";

// Hard negative, mirror image of t3-timing-safe-compare: the SAFE direction.
// == is replaced by hmac.compare_digest. The FP bait is "comparison behavior
// changed on the auth path" — it did, and that is the improvement.
const spec: FixtureSpec = {
  id: "neg-hard-timing-hardening",
  kind: "negative",
  defectClass: "safe-security-hardening",
  description:
    "API token check switches from == to hmac.compare_digest. Pure hardening; no reachable behavior change for valid/invalid tokens.",
  baseFiles: {
    "app/token.py": `import hashlib
import hmac


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def check(stored_hash, presented_token):
    return token_hash(presented_token) == stored_hash


def guard(stored_hash, presented_token, handler):
    if not check(stored_hash, presented_token):
        return {"status": 401}
    return {"status": 200, "result": handler()}
`,
  },
  headFiles: {
    "app/token.py": `import hashlib
import hmac


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def check(stored_hash, presented_token):
    return hmac.compare_digest(token_hash(presented_token), stored_hash)


def guard(stored_hash, presented_token, handler):
    if not check(stored_hash, presented_token):
        return {"status": 401}
    return {"status": 200, "result": handler()}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
