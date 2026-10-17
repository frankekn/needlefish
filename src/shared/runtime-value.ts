import { credentialValuesFromEnv, screenText } from "./outbound-screen.js";
export type RuntimeValue =
  | { readonly status: "unknown" }
  | { readonly status: "known" | "operator_attested"; readonly value: string };

export function runtimeLabel(value: string | undefined, status: "known" | "operator_attested" = "known", kind: "identity" | "model" = "identity"): RuntimeValue {
  const pattern = kind === "model" ? /^[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,159}$/ : /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,159}$/;
  if (!value || !pattern.test(value) ||
      value.includes("://") || /(?:^|\/)(?:Users|home)\//.test(value) ||
      screenText(value, credentialValuesFromEnv(process.env)).kind !== "clean") return Object.freeze({ status: "unknown" });
  return Object.freeze({ status, value });
}
