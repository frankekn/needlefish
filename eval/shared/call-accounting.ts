export const CALL_ACCOUNTING_VERSION = 2;

export interface CallAccountingMetadata {
  readonly callAccountingVersion?: 1 | 2;
}

function version(report: unknown): 1 | 2 | null {
  if (typeof report !== "object" || report === null || Array.isArray(report) || !("callAccountingVersion" in report)) return null;
  const value = report.callAccountingVersion;
  return value === 1 || value === CALL_ACCOUNTING_VERSION ? value : null;
}

export function callAccountingError(previous: unknown, latest: unknown): string | null {
  const previousVersion = version(previous);
  return previousVersion !== null && previousVersion === version(latest) ? null : "call accounting version mismatch";
}
