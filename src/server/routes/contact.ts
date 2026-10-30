import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody } from "../middleware";
import { HttpError, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { newId } from "../lib/crypto";

const schema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(100, "Keep your name under 100 characters."),
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(254),
  company: z.string().trim().max(120).optional(),
  message: z.string().trim().min(10, "Tell us a little more (at least 10 characters).").max(5000, "Keep your message under 5,000 characters."),
  /** Honeypot: a hidden field people never fill. A filled one is a bot; it gets a quiet success. */
  website: z.string().max(500).optional(),
});

/**
 * The public contact form. Sends the message to the support address (SUPPORT_EMAIL) through the
 * platform's own sender, with Reply-To set to the visitor. No database writes.
 */
export function contactFormRoutes() {
  const perIp = new RateLimiter(5, 60 * 60_000);
  return new Hono<AppEnv>().post("/", async (c) => {
    const { deps } = c.var;
    const body = await parseBody(c, schema);
    if (body.website) return c.json({ ok: true });
    if (!perIp.take(c.var.ip)) throw tooMany("Too many messages from your network. Try again later, or email us directly.");
    const to = deps.config.supportEmail;
    const text = [
      `From: ${body.name} <${body.email}>`,
      body.company ? `Company: ${body.company}` : null,
      "",
      body.message,
      "",
      `Sent from the contact form at ${deps.config.appUrl}/contact`,
    ].filter((l) => l !== null).join("\n");
    try {
      const res = await deps.outbound.send({
        from: deps.config.systemFrom, to: [to], replyTo: body.email,
        subject: `Contact form: ${body.name.slice(0, 80)}`, text,
        messageId: `<${newId("contact")}@${deps.config.systemFrom.address.split("@")[1] ?? "localhost"}>`,
      });
      if (res.status !== "sent" && deps.outbound.name !== "log") throw new Error(`status ${res.status}`);
    } catch (err) {
      deps.log?.error("contact.send_failed", { error: String(err) });
      throw new HttpError(502, "send_failed", `Your message couldn't be sent just now. Try again, or email ${to}.`);
    }
    deps.log?.info("contact.sent", {});
    return c.json({ ok: true });
  });
}
