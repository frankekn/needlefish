// Boolean env flags are strictly "1" = on; every other value is off.
export function envFlagOn(name: string): boolean {
	return process.env[name] === "1";
}
