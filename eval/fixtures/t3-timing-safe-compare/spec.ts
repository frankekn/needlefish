import type { FixtureSpec } from "../../shared/types";

// Difficulty: a "simplification" swaps hmac.compare_digest for ==. Behavior is
// identical for every test input; the defect is a timing side-channel on the
// webhook signature check. Requires security knowledge, not diff reading.
const spec: FixtureSpec = {
  id: "t3-timing-safe-compare",
  kind: "positive",
  tier: 3,
  defectClass: "timing-unsafe-signature-compare",
  description:
    "Webhook verification refactor replaces hmac.compare_digest with ==, reintroducing a timing side-channel on signature comparison.",
  baseFiles: {
    "app/webhook.py": `import hashlib
import hmac


def signature_of(payload, secret):
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def verify(payload, secret, given_signature):
    expected = signature_of(payload, secret)
    return hmac.compare_digest(expected, given_signature)


def handle(payload, secret, given_signature, processor):
    if not verify(payload, secret, given_signature):
        return {"status": 401}
    return {"status": 200, "result": processor(payload)}
`,
  },
  headFiles: {
    "app/webhook.py": `import hashlib
import hmac


def signature_of(payload, secret):
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def verify(payload, secret, given_signature):
    return signature_of(payload, secret) == given_signature


def handle(payload, secret, given_signature, processor):
    if not verify(payload, secret, given_signature):
        return {"status": 401}
    return {"status": 200, "result": processor(payload)}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "timing|compare_digest|constant.?time|side.?channel|==.{0,40}(signature|digest|hmac)|signature.{0,32}==" },
    ],
    anchorFile: "app/webhook.py",
    anchorLineRange: [9, 11],
  },
};

export default spec;
