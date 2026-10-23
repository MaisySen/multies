import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { aiUsage, draftReply, invoiceChase, summariseThread, triageMessage } from "../services/ai";

const MessageRef = z.object({ messageId: z.string().min(1) });

/** The AI assistant in the app. Each call that reads mail uses one AI action. */
export function aiRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/usage", async (c) => c.json(await aiUsage(c.var.deps, c.var.auth.orgId)))
    .post("/triage", async (c) => c.json(await triageMessage(c.var.deps, c.var.auth, (await parseBody(c, MessageRef)).messageId)))
    .post("/summary", async (c) => c.json(await summariseThread(c.var.deps, c.var.auth, (await parseBody(c, MessageRef)).messageId)))
    .post("/draft", async (c) => {
      const b = await parseBody(c, MessageRef.extend({ instructions: z.string().max(500).optional(), tone: z.enum(["friendly", "formal", "brief"]).optional() }));
      return c.json(await draftReply(c.var.deps, c.var.auth, b.messageId, b));
    })
    .post("/invoice-chase", async (c) => {
      const b = await parseBody(c, z.object({
        customerName: z.string().trim().min(1).max(100), invoiceNumber: z.string().trim().min(1).max(40),
        amount: z.number().positive().max(100_000_000), currency: z.string().length(3).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-14."),
        businessName: z.string().trim().min(1).max(100), stage: z.enum(["friendly", "firm", "final"]).optional(),
        paymentDetails: z.string().max(500).optional(), senderName: z.string().max(100).optional(),
      }));
      return c.json(invoiceChase(b, c.var.deps.now()));
    });
}
