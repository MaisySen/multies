import type { Deps } from "../context";
import { newId } from "../lib/crypto";
import { deliverInbound, isHosted, logDelivery } from "./mail/delivery";
import { OutboundError } from "./mail/outbound";
import { enqueue, PermanentJobError, registerJob } from "./jobs";

export interface SystemEmail {
  to: string;
  subject: string;
  text: string;
  /** Primary call to action, rendered as a button in the HTML part. */
  action?: { label: string; url: string };
  /** Which React Email template renders the HTML part (defaults to the plain notice). */
  template?: string;
  /** Org the email is about, for the delivery log. */
  orgId?: string;
}

export interface SystemEmailResult {
  /** True when the email reached a real inbox (a MyMail mailbox or an external provider). */
  delivered: boolean;
  via: "internal" | "provider" | "none";
  detail?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderSystemHtml(appName: string, e: SystemEmail): string {
  const paras = e.text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 16px;line-height:1.6">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const button = e.action
    ? `<p style="margin:24px 0"><a href="${esc(e.action.url)}" style="background:#6366f1;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${esc(e.action.label)}</a></p>
       <p style="margin:0 0 16px;font-size:12px;color:#71717a">Or paste this link into your browser:<br><span style="word-break:break-all">${esc(e.action.url)}</span></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;padding:32px 16px;font-family:-apple-system,Segoe UI,Inter,sans-serif;color:#18181b">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e4e4e7">
<div style="font-weight:700;font-size:16px;margin-bottom:24px">${esc(appName)}</div>${paras}${button}
</div></body></html>`;
}

/**
 * Sends an account email (invite, password reset, verification). Recipients hosted on
 * this platform get it delivered straight into their mailbox; others go through the
 * outbound provider. With no provider configured nothing leaves the platform and the
 * result says so, so callers can offer a copyable link instead.
 */
export async function sendSystemEmail(deps: Deps, e: SystemEmail): Promise<SystemEmailResult> {
  const { config } = deps;
  const text = e.action ? `${e.text}\n\n${e.action.label}: ${e.action.url}\n` : e.text;
  const html = renderSystemHtml(config.appName, e);
  const messageId = `<${newId("sys")}@${config.systemFrom.address.split("@")[1] ?? "localhost"}>`;
  const to = e.to.toLowerCase();

  if (await isHosted(deps.db, to)) {
    const r = await deliverInbound(deps, {
      envelopeFrom: config.systemFrom.address,
      rcptTo: to,
      sizeBytes: text.length + html.length,
      via: "internal",
      email: {
        messageId, from: { address: config.systemFrom.address, name: config.systemFrom.name },
        to: [{ address: to }], cc: [], subject: e.subject, text, html,
        date: deps.now(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" },
        headers: { "auto-submitted": "auto-generated" },
      },
    });
    return { delivered: r.accepted, via: "internal", detail: r.reason };
  }

  if (deps.outbound.name === "log") {
    // Recorded by the log transport (development and tests); nothing leaves the platform.
    await deps.outbound.send({ from: config.systemFrom, to: [to], subject: e.subject, text, html, messageId }).catch(() => undefined);
    return { delivered: false, via: "none", detail: "Email delivery isn't connected on this deployment." };
  }
  try {
    const res = await deps.outbound.send({ from: config.systemFrom, to: [to], subject: e.subject, text, html, messageId });
    if (res.status === "sent") deps.log?.info("system_mail.sent", { template: e.template ?? "notice" });
    if (e.orgId) {
      await logDelivery(deps.db, {
        orgId: e.orgId, direction: "outbound", fromAddress: config.systemFrom.address, toAddress: to, subject: e.subject,
        status: res.status, provider: res.provider, providerMessageId: res.providerMessageId ?? null, detail: "Account email",
      });
    }
    return { delivered: res.status === "sent", via: "provider", detail: res.detail };
  } catch (err) {
    if (!(err instanceof OutboundError) || err.retryable) {
      // Provider unavailable: retry from the job queue so the person still gets it.
      await enqueue(deps, "system-mail.send", { to, subject: e.subject, text, html, messageId, orgId: e.orgId ?? null }, { orgId: e.orgId ?? null, delayMs: 30_000, maxAttempts: 6 });
      return { delivered: false, via: "provider", detail: "Delayed: the email provider is unavailable right now. It will be retried automatically." };
    }
    return { delivered: false, via: "provider", detail: err.message };
  }
}

registerJob("system-mail.send", async (deps, payload) => {
  const p = payload as { to: string; subject: string; text: string; html: string; messageId: string; orgId: string | null };
  try {
    await deps.outbound.send({ from: deps.config.systemFrom, to: [p.to], subject: p.subject, text: p.text, html: p.html, messageId: p.messageId });
  } catch (err) {
    if (err instanceof OutboundError && !err.retryable) throw new PermanentJobError(err.message);
    throw err;
  }
});
