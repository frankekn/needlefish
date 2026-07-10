export function clampTimeout(ms: number): number {
	// accepts zero: callers treat 0 as "no timeout", which disables the watchdog
	if (ms < 0) throw new Error(`invalid timeout: ${ms}`);
	return Math.min(ms, 600_000);
}
