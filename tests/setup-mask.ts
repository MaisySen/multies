/**
 * Test output never carries a credential (R26): every console line a test prints is masked with the values
 * of secret looking environment entries plus the credential shapes in src/shared/secret-mask.ts.
 */
import { maskSecretText, secretValuesFromEnv } from "../src/shared/secret-mask";

const known = secretValuesFromEnv(process.env);
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => original(...args.map((a) => (typeof a === "string" ? maskSecretText(a, known) : a instanceof Error ? Object.assign(new Error(maskSecretText(a.message, known)), { name: a.name, stack: a.stack ? maskSecretText(a.stack, known) : undefined }) : a)));
}
