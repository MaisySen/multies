/**
 * Account emails built with React Email (react.email): table based layouts that render
 * the same in Gmail, Outlook, Apple Mail and dark mode. Each template takes typed props;
 * `renderEmail` returns the HTML and plain text parts.
 */
import { Body, Button, Column, Container, Head, Heading, Hr, Html, Link, Preview, Row, Section, Text } from "@react-email/components";
import { render } from "@react-email/render";
import type { ReactNode } from "react";

const brand = "#6366f1";
const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif";
const s = {
  body: { backgroundColor: "#f4f4f5", fontFamily: font, color: "#18181b", margin: 0, padding: "32px 12px" },
  card: { backgroundColor: "#ffffff", border: "1px solid #e4e4e7", borderRadius: "12px", maxWidth: "520px", padding: "32px" },
  logo: { fontSize: "16px", fontWeight: 700, margin: "0 0 24px" },
  h1: { fontSize: "20px", fontWeight: 600, lineHeight: "28px", margin: "0 0 16px" },
  p: { fontSize: "14px", lineHeight: "22px", margin: "0 0 16px" },
  muted: { fontSize: "12px", lineHeight: "18px", color: "#71717a", margin: "0 0 8px" },
  button: { backgroundColor: brand, borderRadius: "8px", color: "#ffffff", fontSize: "14px", fontWeight: 600, padding: "11px 18px", textDecoration: "none" },
  footer: { fontSize: "12px", lineHeight: "18px", color: "#a1a1aa", maxWidth: "520px", margin: "16px auto 0", textAlign: "center" as const },
};

export interface Brand { appName: string; appUrl: string; address?: string }
export interface Action { label: string; url: string }

function Layout({ brand: b, preview, title, children, action, reason }: { brand: Brand; preview: string; title: string; children: ReactNode; action?: Action; reason: string }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={s.body}>
        <Container style={s.card}>
          <Text style={s.logo}>{b.appName}</Text>
          <Heading as="h1" style={s.h1}>{title}</Heading>
          {children}
          {action && (
            <>
              <Section style={{ margin: "24px 0" }}><Button href={action.url} style={s.button}>{action.label}</Button></Section>
              <Text style={s.muted}>Or paste this link into your browser:<br /><Link href={action.url} style={{ color: "#71717a", wordBreak: "break-all" }}>{action.url}</Link></Text>
            </>
          )}
        </Container>
        <Text style={s.footer}>{reason} {b.appName}{b.address ? `, ${b.address}` : ""}. <Link href={b.appUrl} style={{ color: "#a1a1aa" }}>{b.appUrl.replace(/^https?:\/\//, "")}</Link></Text>
      </Body>
    </Html>
  );
}

const Paras = ({ text }: { text: string }) => <>{text.split(/\n{2,}/).map((p, i) => <Text key={i} style={s.p}>{p}</Text>)}</>;

/** Generic notice: security alerts, deletions, webhook problems, undeliverable mail. */
export function Notice(p: { brand: Brand; title: string; text: string; action?: Action }) {
  return <Layout brand={p.brand} preview={p.text.slice(0, 120)} title={p.title} action={p.action} reason="You received this because of activity on your account with"><Paras text={p.text} /></Layout>;
}

export function Verify(p: { brand: Brand; name: string; email: string; url: string }) {
  return (
    <Layout brand={p.brand} preview={`Confirm ${p.email} for ${p.brand.appName}`} title="Confirm your email" action={{ label: "Confirm email", url: p.url }} reason="You received this because this address signed up for">
      <Text style={s.p}>Hi {p.name}, confirm that {p.email} is your address so we can reach you about your account. The link works for 3 days.</Text>
    </Layout>
  );
}

export function Reset(p: { brand: Brand; email: string; url: string }) {
  return (
    <Layout brand={p.brand} preview="Reset link, valid for one hour" title="Reset your password" action={{ label: "Choose a new password", url: p.url }} reason="You received this because a password reset was requested on">
      <Text style={s.p}>Someone (hopefully you) asked to reset the password for {p.email}. The link works for one hour.</Text>
      <Text style={s.p}>If you didn't ask for this, ignore this email. Your password stays the same.</Text>
    </Layout>
  );
}

export function Invite(p: { brand: Brand; inviter: string; inviterEmail: string; workspace: string; role: string; url: string }) {
  return (
    <Layout brand={p.brand} preview={`${p.inviter} invited you to ${p.workspace}`} title={`Join ${p.workspace}`} action={{ label: "Accept invitation", url: p.url }} reason="You received this because a workspace owner invited you to">
      <Text style={s.p}>{p.inviter} ({p.inviterEmail}) invited you to the {p.workspace} workspace as {p.role === "admin" ? "an admin" : "a member"}.</Text>
      <Text style={s.p}>The invitation expires in 7 days.</Text>
    </Layout>
  );
}

export function Welcome(p: { brand: Brand; name: string }) {
  const steps = [
    ["Add your domain", "We show the exact DNS records and check them for you."],
    ["Create mailboxes", "One per person or role, plus aliases like hello@."],
    ["Connect your apps", "Use webmail, or add the account to Apple Mail, Outlook or your phone."],
  ];
  return (
    <Layout brand={p.brand} preview="Three steps to email on your own domain" title={`Welcome, ${p.name}`} action={{ label: "Open your dashboard", url: `${p.brand.appUrl}/app` }} reason="You received this because you created an account with">
      <Text style={s.p}>Your workspace is ready. Most people are sending from their own domain within 15 minutes:</Text>
      {steps.map(([t, d], i) => (
        <Row key={t} style={{ marginBottom: "12px" }}>
          <Column style={{ width: "28px", verticalAlign: "top" }}><Text style={{ ...s.p, margin: 0, color: brand, fontWeight: 700 }}>{i + 1}</Text></Column>
          <Column><Text style={{ ...s.p, margin: 0 }}><strong>{t}.</strong> {d}</Text></Column>
        </Row>
      ))}
      <Text style={s.p}>Reply to this email if you get stuck. A person reads every reply.</Text>
    </Layout>
  );
}

export interface ReceiptLine { description: string; amount: string }
export function Receipt(p: { brand: Brand; workspace: string; number: string; date: string; lines: ReceiptLine[]; total: string; tax?: string; url?: string }) {
  return (
    <Layout brand={p.brand} preview={`Receipt ${p.number}: ${p.total} paid`} title={`Payment received: ${p.total}`} action={p.url ? { label: "View invoice", url: p.url } : undefined} reason="You received this because you manage billing for a workspace on">
      <Text style={s.p}>Thanks. Here is your receipt for {p.workspace}.</Text>
      <Text style={s.muted}>Receipt {p.number} · {p.date}</Text>
      <Hr style={{ borderColor: "#e4e4e7", margin: "12px 0" }} />
      {p.lines.map((l) => (
        <Row key={l.description}><Column><Text style={{ ...s.p, margin: "4px 0" }}>{l.description}</Text></Column><Column align="right"><Text style={{ ...s.p, margin: "4px 0" }}>{l.amount}</Text></Column></Row>
      ))}
      {p.tax && <Row><Column><Text style={{ ...s.muted, margin: "4px 0" }}>Includes GST</Text></Column><Column align="right"><Text style={{ ...s.muted, margin: "4px 0" }}>{p.tax}</Text></Column></Row>}
      <Hr style={{ borderColor: "#e4e4e7", margin: "12px 0" }} />
      <Row><Column><Text style={{ ...s.p, fontWeight: 600 }}>Total paid</Text></Column><Column align="right"><Text style={{ ...s.p, fontWeight: 600 }}>{p.total}</Text></Column></Row>
    </Layout>
  );
}

export function UsageAlert(p: { brand: Brand; workspace: string; metric: string; used: number; limit: number; plan: string; nextPlan?: string }) {
  const pct = Math.min(100, Math.round((p.used / Math.max(1, p.limit)) * 100));
  const full = pct >= 100;
  return (
    <Layout brand={p.brand} preview={`${p.workspace} has used ${pct}% of its ${p.metric}`} title={full ? `You've reached your ${p.metric} limit` : `You've used ${pct}% of your ${p.metric}`}
      action={p.nextPlan ? { label: `Upgrade to ${p.nextPlan}`, url: `${p.brand.appUrl}/app/settings/billing` } : undefined} reason="You received this because you manage a workspace on">
      <Text style={s.p}>{p.workspace} is on the {p.plan} plan and has used {p.used.toLocaleString("en-AU")} of {p.limit.toLocaleString("en-AU")} {p.metric}.</Text>
      <Section style={{ backgroundColor: "#f4f4f5", borderRadius: "999px", height: "8px", margin: "0 0 16px" }}>
        <div style={{ backgroundColor: full ? "#dc2626" : pct >= 80 ? "#d97706" : brand, borderRadius: "999px", height: "8px", width: `${pct}%` }} />
      </Section>
      <Text style={s.p}>{full ? "New items over the limit are refused until it resets or you upgrade." : "Nothing stops yet. We'll email again if you reach the limit."}</Text>
    </Layout>
  );
}

export function PaymentFailed(p: { brand: Brand; workspace: string; amount: string; graceEnds: string; final?: boolean }) {
  return (
    <Layout brand={p.brand} preview={`Payment for ${p.workspace} didn't go through`} title={p.final ? "Sending is paused until payment" : "Your payment didn't go through"}
      action={{ label: "Update payment method", url: `${p.brand.appUrl}/app/settings/billing` }} reason="You received this because you manage billing for a workspace on">
      <Text style={s.p}>We couldn't charge {p.amount} for {p.workspace}. We'll retry automatically over the next few days.</Text>
      <Text style={s.p}>{p.final ? "The grace period has ended, so sending is paused. Receiving mail and access to existing mail continue. Updating your card restores sending straight away." : `Everything keeps working until ${p.graceEnds}. After that, sending pauses until the payment goes through. Receiving mail is never paused.`}</Text>
    </Layout>
  );
}

/** Renders a template to the HTML and plain text parts of an email. */
export async function renderEmail(el: React.ReactElement) {
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
  return { html, text };
}
