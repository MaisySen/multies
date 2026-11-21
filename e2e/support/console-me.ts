/** OPS1: a mocked GET /api/console/me for console specs that need an operator without a real operator account. */
import type { Page } from "@playwright/test";
import { OPERATOR_ROLE_LABELS, permissionsOf, type OperatorRole } from "../../src/shared/operator-permissions";

export function consoleMe(role: OperatorRole, email = "olive@example.com") {
  return {
    user: { id: "usr_e2e_ops", email, name: "Olive Operator" },
    role, roleLabel: OPERATOR_ROLE_LABELS[role], permissions: permissionsOf(role),
    twoFactor: true, loginMethod: "email", signedInAt: new Date().toISOString(), freshMinutes: 15, fresh: true, envManaged: false,
    environment: { mode: "development", release: "e2e" },
  };
}

export async function mockConsoleMe(page: Page, role: OperatorRole = "admin") {
  await page.route("**/api/console/me", (r) => r.fulfill({ json: consoleMe(role) }));
}
