import { createElement, type ReactElement } from "react";
// R53 (cold start): the mail templates (and the mail component library, about 58 ms of module init in the profile) load
// on the first mail an isolate sends, not at every isolate's startup.
import type { Brand } from "../emails";
const loadEmails = () => import("../emails");
import type { Deps } from "../context";
import { newId } from "../lib/crypto";
import { deliverInbound, logDelivery, routeRecipient } from "./mail/delivery";
import { OutboundError } from "./mail/outbound";
import { enqueue, PermanentJobError, registerJob } from "./jobs";
import { eq } from "drizzle-orm";
import { domains, organizations } from "../db/schema";
import { systemDomainOf } from "./suite/operator-inbox";
import type { AgentAddress } from "./agents/agent-address";

/**
 * PRIV1b (SP5): the one stamp rule for mail the platform delivers as itself (account mail, bounce notices). Pass while
 * no workspace holds the system domain short of verified (assertDomainAllowed reserves it for the operator); a name no
 * workspace holds is the deployment's own mail domain. One indexed read.
 */
export async function systemMailAuth(deps: Deps) {
  const row = await deps.db.select({ status: domains.status }).from(domains).where(eq(domains.name, systemDomainOf(deps.config))).get();
  return !row || row.status === "verified" ? { spf: "pass" as const, dkim: "pass" as const, dmarc: "pass" as const } : { spf: "none" as const, dkim: "none" as const, dmarc: "none" as const };
}

async function isDemoOrg(deps: Deps, orgId: string) {
  const row = await deps.db.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, orgId)).get();
  return !!row?.isDemo;
}

export interface SystemEmail {
  to: string;
  subject: string;
  text: string;
  /** Primary call to action, rendered as a button in the HTML part. */
  action?: { label: string; url: string };
  /** Which React Email template renders the HTML part (defaults to the plain notice). */
  template?: string;
  /** A React Email template (src/server/emails) for the HTML part; `text` stays the plain part. */
  element?: ReactElement;
  /** Org the email is about, for the delivery log. */
  orgId?: string;
  /**
   * PRIV1b (P37): mail that can take over an account (password reset, email confirmation, invitation, account deleted).
   * Delivered inside the platform only to a mailbox at exactly that address, never through an alias or a catch all
   * an admin can point anywhere; otherwise it goes out through the provider like mail to an outside address.
   */
  accountSecurity?: boolean;
}

/**
 * AIS1 (row 32): where account mail (accountSecurity) is not sent at all: an AI agent's own inbox (a +tag of it
 * included) and an agent member's internal address. Not "alias" or "catch_all": see sendSystemEmail.
 */
const SKIP_ACCOUNT_MAIL: ReadonlySet<AgentAddress["via"]> = new Set<AgentAddress["via"]>(["agent_inbox", "agent_member"]);

/** Why account mail to an AI agent's inbox was not sent (the result's detail and the agent workspace's delivery log). */
export const ACCOUNT_MAIL_NOT_SENT_TO_AGENT = "Not sent: this address is an AI agent's inbox. Multies doesn't send account email to agents.";

export interface SystemEmailResult {
  /** True when the email reached a real inbox (a Multies mailbox or an external provider). */
  delivered: boolean;
  via: "internal" | "provider" | "none";
  detail?: string;
}


/** The brand block every React Email template shares. */
export const emailBrand = (deps: Deps): Brand => ({ appName: deps.config.appName, appUrl: deps.config.appUrl });

/** HTML part: the template element when the caller built one, else the generic notice. */
export async function renderSystemHtml(deps: Deps, e: SystemEmail): Promise<string> {
  const { Notice, renderEmail } = await loadEmails();
  const el = e.element ?? createElement(Notice, { brand: emailBrand(deps), title: e.subject, text: e.text, action: e.action });
  return (await renderEmail(el)).html;
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
  const html = await renderSystemHtml(deps, e);
  const messageId = `<${newId("sys")}@${config.systemFrom.address.split("@")[1] ?? "localhost"}>`;
  const to = e.to.toLowerCase();

  const route = await routeRecipient(deps.db, to);
  // AIS1 (row 32): mail that can take over an account is never sent to an AI agent's own address: its inbox (or a
  // +tag of it) or an agent member's internal address. Nobody else reads mail there. An alias or a catch-all that
  // also reaches an agent is often a person's own address ("send my mail to my Gmail and my AI"), so that mail goes
  // out as usual: it comes back in from the system sender, and the agent's copy is withheld (agents/platform-mail.ts),
  // and an alias never forwards it to another workspace's agent (mail/delivery.ts). A few indexed reads, only for
  // account mail (sign up, reset, invite), never on a signed in request. To skip more, add a `via` to SKIP_ACCOUNT_MAIL.
  if (e.accountSecurity) {
    const { agentAddress } = await import("./agents/agent-address");
    const agent = await agentAddress(deps.db, to);
    if (agent && SKIP_ACCOUNT_MAIL.has(agent.via)) {
      deps.log?.warn("system_mail.agent_inbox_skipped", { template: e.template ?? "notice", via: agent.via, orgId: agent.orgId });
      // The agent's workspace sees why it never arrived: the delivery log names the address. One write, only here.
      if (agent.orgId) {
        await logDelivery(deps.db, {
          orgId: agent.orgId, direction: "outbound", fromAddress: config.systemFrom.address, toAddress: to, subject: e.subject,
          status: "rejected", provider: "internal", detail: ACCOUNT_MAIL_NOT_SENT_TO_AGENT,
        }).catch((err: unknown) => deps.reportError?.(err, { where: "system_mail.agent_inbox_skipped" }));
      }
      return { delivered: false, via: "none", detail: ACCOUNT_MAIL_NOT_SENT_TO_AGENT };
    }
  }
  const internal = e.accountSecurity ? route.kind === "mailbox" && route.mailbox.address.toLowerCase() === to : route.kind !== "none";
  if (internal) {
    const r = await deliverInbound(deps, {
      envelopeFrom: config.systemFrom.address,
      rcptTo: to,
      sizeBytes: text.length + html.length,
      via: "internal",
      platformMail: "system", // AIS1 (row 32): agents and apps never get this mail's text, codes or links
      email: {
        messageId, from: { address: config.systemFrom.address, name: config.systemFrom.name },
        to: [{ address: to }], cc: [], subject: e.subject, text, html,
        date: deps.now(), attachments: [], authResults: await systemMailAuth(deps), // PRIV1b (SP5)
        headers: { "auto-submitted": "auto-generated" },
      },
    });
    return { delivered: r.accepted, via: "internal", detail: r.reason };
  }

  // R40 deploy 3 (MB-220): an anonymous demo workspace never mails anyone outside Multies (its sample people
  // are not real), so it cannot be used to send mail from our domain to any address.
  if (e.orgId && (await isDemoOrg(deps, e.orgId))) {
    deps.log?.info("system_mail.demo_skipped", { template: e.template ?? "notice" });
    return { delivered: false, via: "none", detail: "Demo workspaces send no email." };
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
