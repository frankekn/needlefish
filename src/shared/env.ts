export function envFlagOn(name: string): boolean {
	return process.env[name] === "1";
}
