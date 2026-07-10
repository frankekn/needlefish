import type { FixtureSpec } from "../../shared/types";

// HOLDOUT: sealed at authoring time (eval-hardening round, 2026-07-09).
// Hard negative: the diff adds a permission requirement that LOOKS like it
// could lock users out, but every call site visible in the repo already
// guarantees the permission before calling. The FP bait is "breaking change".
const spec: FixtureSpec = {
  id: "neg-hard-tighten-auth",
  kind: "negative",
  holdout: true,
  defectClass: "safe-authorization-tightening",
  description:
    "export_report now raises unless the caller holds the 'reports' grant. Both call sites already check the grant (route decorator and cron allowlist), so no reachable path changes behavior.",
  baseFiles: {
    "app/reports.py": `def export_report(user, report_id, storage):
    data = storage.fetch(report_id)
    return render_csv(data)


def render_csv(rows):
    return "\\n".join(",".join(str(c) for c in row) for row in rows)
`,
    "app/routes.py": `from .auth import require_grant
from .reports import export_report


@require_grant("reports")
def download_report(user, report_id, storage):
    return export_report(user, report_id, storage)
`,
    "app/cron.py": `from .reports import export_report

NIGHTLY_EXPORT_GRANTS = ("reports", "audit")


def nightly_export(system_user, storage):
    if "reports" not in system_user.grants:
        raise PermissionError("system user lost the reports grant")
    return export_report(system_user, "nightly", storage)
`,
    "app/auth.py": `def require_grant(name):
    def wrap(fn):
        def inner(user, *args, **kwargs):
            if name not in user.grants:
                raise PermissionError(name)
            return fn(user, *args, **kwargs)
        return inner
    return wrap
`,
  },
  headFiles: {
    "app/reports.py": `def export_report(user, report_id, storage):
    if "reports" not in user.grants:
        raise PermissionError("reports grant required")
    data = storage.fetch(report_id)
    return render_csv(data)


def render_csv(rows):
    return "\\n".join(",".join(str(c) for c in row) for row in rows)
`,
    "app/routes.py": `from .auth import require_grant
from .reports import export_report


@require_grant("reports")
def download_report(user, report_id, storage):
    return export_report(user, report_id, storage)
`,
    "app/cron.py": `from .reports import export_report

NIGHTLY_EXPORT_GRANTS = ("reports", "audit")


def nightly_export(system_user, storage):
    if "reports" not in system_user.grants:
        raise PermissionError("system user lost the reports grant")
    return export_report(system_user, "nightly", storage)
`,
    "app/auth.py": `def require_grant(name):
    def wrap(fn):
        def inner(user, *args, **kwargs):
            if name not in user.grants:
                raise PermissionError(name)
            return fn(user, *args, **kwargs)
        return inner
    return wrap
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
