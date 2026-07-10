import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "t1-null-check-removed",
  kind: "positive",
  tier: 1,
  defectClass: "removed-none-guard",
  description:
    "The diff deletes the None guard in front of attribute access while tidying the function; load_settings returns None for absent files, so startup crashes with AttributeError on any fresh install.",
  baseFiles: {
    "app/config.py": `import json
import os


def load_settings(path):
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        return json.load(fh)


def startup(path):
    settings = load_settings(path)
    if settings is None:
        settings = {"workers": 1, "region": "us-east-1"}
    return int(settings["workers"])
`,
  },
  headFiles: {
    "app/config.py": `import json
import os


def load_settings(path):
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        return json.load(fh)


def startup(path):
    settings = load_settings(path)
    return int(settings["workers"])
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "none|null|crash|TypeError|AttributeError|not subscriptable|missing.{0,16}(file|guard|check)|fresh install|guard.{0,16}(remov|delet|dropp)" },
    ],
    anchorFile: "app/config.py",
    anchorLineRange: [12, 14],
  },
};

export default spec;
