/** POL1 (MB-313): who may move a table or a course to the trash and restore it. Pure, shared by the services and the tests. */
import type { SuiteActor } from "./suite/common";

export type TrashKind = "table" | "course";

/** Who may move a table or a course to the trash (and restore it). Pure, for the UI flag and the tests. */
export function canTrash(a: Pick<SuiteActor, "role" | "scope" | "userId">, kind: TrashKind, createdBy: string | null | undefined): boolean {
  if (a.scope === "read") return false;
  if (a.role === "owner" || a.role === "admin") return true;
  if (kind === "course") return false;
  return !!a.userId && !!createdBy && a.userId === createdBy;
}

