import { z } from "zod";
import { parseMnetObject } from "./mnet-json";

const exactUrl = (origin: boolean) => z.string().max(2048).refine((s) => {
  try { const u = new URL(s); return !/[\s?#\\]/u.test(s) && !s.slice(8).split("/")[0]!.includes("@") && s.startsWith("https://") && u.protocol === "https:" && !!u.hostname && !s.endsWith(":") && u.port !== "0" && !u.username && !u.password && (!origin || /^https:\/\/[^/]+$/.test(s)); } catch { return false; }
});
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const principal = z.string().min(1).max(256).refine((s) => s.trim() === s && !/[\s\p{Cc}]/u.test(s));
export const enrollmentOperatorSchema = z.object({
  revision: id, issuer: exactUrl(false), registrarOrigin: exactUrl(true), audience: principal,
  bindings: z.array(z.object({ workspaceId: id, networkId: id, principals: z.array(principal).min(1).max(100) }).strict()).min(1).max(20),
}).strict().superRefine((c, ctx) => {
  if (new Set(c.bindings.map((b) => b.workspaceId)).size !== c.bindings.length || c.bindings.some((b) => new Set(b.principals).size !== b.principals.length)) ctx.addIssue({ code: "custom", message: "Duplicate operator binding" });
});
export type EnrollmentOperatorConfig = z.infer<typeof enrollmentOperatorSchema>;
// Explicit branch-only operator input, no default origins or inferred members.
// User IDs are the immutable local subjects for this configured issuer.
export function enrollmentOperatorConfig(raw?: string): EnrollmentOperatorConfig | undefined {
  if (!raw) return undefined;
  if (raw.length > 65536) throw new Error("Invalid Mnet enrollment operator configuration");
  try { return enrollmentOperatorSchema.parse(parseMnetObject(raw)); } catch { throw new Error("Invalid Mnet enrollment operator configuration"); }
}
