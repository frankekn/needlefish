import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-t1-plugin-write-token",
  kind: "positive",
  tier: 1,
  defectClass: "subprocess-inherits-write-token",
  holdout: true,
  description: "Synthetic extension launcher leaks its parent service write credential by dropping the filtered child environment.",
  baseFiles: {
    "README.md": `The service owns WRITE_TOKEN for publishing. Extensions must never receive this credential. Ordinary environment configuration such as LANG must remain available. run_extension receives an absolute Python extension path.
`,
    "extension.py": `import os
import subprocess
import sys

def run_extension(script):
    child_env = {key: value for key, value in os.environ.items() if key != "WRITE_TOKEN"}
    return subprocess.check_output([sys.executable, script], env=child_env, text=True)
`,
  },
  headFiles: {
    "extension.py": `import os
import subprocess
import sys

def run_extension(script):
    child_env = {key: value for key, value in os.environ.items() if key != "WRITE_TOKEN"}
    return subprocess.check_output([sys.executable, script], text=True)
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [{ pattern: "inherit|WRITE_TOKEN|credential|token.{0,30}(leak|expos|child|extension)|environment", file: "extension.py", lineRange: [7, 7] }],
    anchorFile: "extension.py",
    anchorLineRange: [7, 7],
  },
};

export default spec;
