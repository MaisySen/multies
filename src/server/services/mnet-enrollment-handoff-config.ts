import { z } from "zod";
import { parseMnetObject } from "./mnet-json";

// Required local-fixture inputs. No production defaults or release policy.
export const enrollmentHandoffFixtureSchema = z.object({
 consentMs: z.number().int().min(1000).max(600000),
 codeMs: z.number().int().min(1000).max(60000),
 ticketMs: z.number().int().min(1000).max(120000),
 fullRowRetentionMs: z.number().int().min(1000).max(90 * 86400000),
 capacity: z.number().int().min(1).max(20),
 maxRows: z.number().int().min(1).max(10000),
 retention: z.literal("terminal-hash-tombstone"),
}).strict().refine((p) => p.codeMs <= p.consentMs && p.capacity <= p.maxRows);
export type EnrollmentHandoffFixture = z.infer<typeof enrollmentHandoffFixtureSchema>;
export function enrollmentHandoffFixtureConfig(enabled: boolean, mode: string, raw?: string): EnrollmentHandoffFixture | undefined {
 if (!enabled) return undefined;
 if (mode !== "development" || !raw || raw.length > 4096) throw new Error("Enrollment handoff requires explicit local development fixture configuration");
 try { return enrollmentHandoffFixtureSchema.parse(parseMnetObject(raw)); } catch { throw new Error("Invalid enrollment handoff fixture configuration"); }
}
