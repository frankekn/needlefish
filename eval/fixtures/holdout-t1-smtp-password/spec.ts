import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-t1-smtp-password",
  kind: "positive",
  tier: 1,
  defectClass: "hardcoded-credential",
  holdout: true,
  description: "Synthetic mail deployment embeds its SMTP password in source instead of reading the operator secret.",
  baseFiles: {
    "README.md": `SMTP_PASSWORD supplies the deployment password. Every send must use its current value. Source is distributed to operators.
`,
    "mailer.py": `import os

def deliver(client, message):
    password = os.environ["SMTP_PASSWORD"]
    client.login("mailer", password)
    return client.send(message)
`,
  },
  headFiles: {
    "mailer.py": `import os

def deliver(client, message):
    password = "mail-shared-production-password"
    client.login("mailer", password)
    return client.send(message)
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [{ pattern: "hard.?cod|password.{0,30}(source|literal|expos|leak|commit)|credential|secret.{0,20}(source|expos|leak)", file: "mailer.py", lineRange: [4, 4] }],
    anchorFile: "mailer.py",
    anchorLineRange: [4, 4],
  },
};

export default spec;
