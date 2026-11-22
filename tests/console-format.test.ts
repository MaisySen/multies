/**
 * OPS1 polish: the console's shared formatting (pages/console/components/format.tsx): plain labels with humanised
 * fallbacks, one plan name per plan id, one tone per state, day-first dates with a fixed clock, locale and zone, the
 * first sort direction of a column, the console's own read (server messages kept, no retries on an answer), and the
 * small states rendered to static markup.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  AUDIT_ACTIONS_WITHOUT_REASON, EMPTY, Empty, JobStatusBadge, OperatorRoleBadge, PersonLink, RelTime, StatusBadge, TwoStepBadge, WorkspaceLink,
  auditActionLabel, auditFieldLabel, compPlanLabel, dnsFailingText, dnsRecordLabel, eventTypeLabel, formatDateTime, formatDay, humanize,
  integrationLabel, jobStatusLabel, jobTypeLabel, planLabel, relativeTime, statusTone,
  EVENT_TYPE_LABELS, JOB_TYPE_LABELS, shortWorkspaceId, workspaceHint,
} from "../src/web/pages/console/components/format";
import { WEBHOOK_EVENTS } from "../src/server/services/developer/webhooks";
import { EmptyRow, LoadError, consoleErrorMessage, isNoAccess } from "../src/web/pages/console/components/states";
import { firstSortDir } from "../src/web/pages/console/components/data-table";
import { JsonDiff, showValue } from "../src/web/pages/console/components/json-diff";
import { ApiError } from "../src/web/lib/api";
import { consoleGet, consoleRetry } from "../src/web/lib/console-api";

const AU = { locale: "en-AU", timeZone: "Australia/Sydney" };
const UTC = { locale: "en-AU", timeZone: "UTC" };
function html<P extends object>(node: (p: P) => ReactNode, props: P): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(node as FunctionComponent<P>, props)));
}

describe("plain labels", () => {
  it("humanises raw ids", () => {
    expect(humanize("mail.send")).toBe("Mail send");
    expect(humanize("sendCapDaily")).toBe("Send cap daily");
    expect(humanize("past_due")).toBe("Past due");
    expect(humanize("system-mail.send")).toBe("System mail send");
    expect(humanize("")).toBe(EMPTY);
    expect(humanize(null)).toBe(EMPTY);
  });
  it("keeps known words whole and leaves ready-made labels alone", () => {
    expect(humanize("minIosBuild")).toBe("Min iOS build");
    expect(humanize("iPhoneBuild")).toBe("iPhone build");
    expect(humanize("oldest_iphone_build")).toBe("Oldest iPhone build");
    expect(humanize("oauthGrantId")).toBe("OAuth grant ID");
    expect(humanize("OAuthGrant")).toBe("OAuth grant");
    expect(humanize("apiKeyUrl")).toBe("API key URL");
    expect(humanize("APIKey")).toBe("API key");
    expect(humanize("dns.mx_record")).toBe("DNS MX record");
    expect(humanize("requireSso")).toBe("Require SSO");
    expect(humanize("ai_calls")).toBe("AI calls");
    expect(humanize("userId")).toBe("User ID");
    expect(humanize("ios")).toBe("iOS");
    expect(humanize("macOSVersion")).toBe("macOS version");
    // Never inside an ordinary word.
    expect(humanize("paidAt")).toBe("Paid at");
    expect(humanize("said")).toBe("Said");
    expect(humanize("video_ids")).toBe("Video ids");
    // Anything with a space is already words.
    expect(humanize("Oldest iPhone build allowed")).toBe("Oldest iPhone build allowed");
    expect(humanize("Min build (iOS)")).toBe("Min build (iOS)");
    expect(auditFieldLabel("Oldest iPhone build allowed")).toBe("Oldest iPhone build allowed");
    const diff = html(JsonDiff, { before: { "Oldest iPhone build allowed": "100" }, after: { "Oldest iPhone build allowed": "120" } });
    expect(diff).toContain(">Oldest iPhone build allowed<");
    expect(diff).not.toContain("i phone");
  });
  it("labels every job type the server registers and every webhook event it sends", () => {
    const src = readFileSync(new URL("../src/server/services/jobs.ts", import.meta.url), "utf8");
    const union = /export type JobType = ([^;]+);/.exec(src)![1]!;
    const types = [...union.matchAll(/"([a-z0-9_.-]+)"/g)].map((m) => m[1]!);
    expect(types.length).toBeGreaterThan(5);
    for (const t of types) expect(JOB_TYPE_LABELS[t], t).toBeTruthy();
    for (const e of WEBHOOK_EVENTS) expect(EVENT_TYPE_LABELS[e], e).toBeTruthy();
    expect(eventTypeLabel("webhook.test")).toBe("Test event");
    expect(jobTypeLabel("demo.seed_suite")).toBe("Demo workspace setup");
  });
  it("names plans the way the customer app does", () => {
    expect(planLabel("starter")).toBe("Free");
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("business")).toBe("Business");
    expect(planLabel("enterprise_plus")).toBe("Enterprise plus");
    expect(planLabel(null)).toBe(EMPTY);
    expect(compPlanLabel("business")).toBe("Free Business plan");
  });
  it("words jobs, events, DNS records and audit actions, with a humanised fallback", () => {
    expect(jobTypeLabel("mail.deliver")).toBe("Mail delivery");
    expect(jobTypeLabel("test.something_new")).toBe("Test something new");
    expect(eventTypeLabel("message.bounced")).toBe("Mail bounced");
    expect(eventTypeLabel("brand_new.event")).toBe("Brand new event");
    expect(eventTypeLabel("chat.message.created")).toBe("Chat message sent");
    expect(dnsRecordLabel("return_mx")).toBe("Return path MX");
    expect(dnsRecordLabel("bimi")).toBe("BIMI");
    expect(dnsRecordLabel("ownership")).toBe("Ownership TXT");
    expect(dnsFailingText(["ownership", "mx"])).toBe("Ownership TXT, MX missing");
    expect(dnsFailingText(["mx", "spf"])).toBe("MX, SPF missing");
    expect(dnsFailingText([])).toBe(EMPTY);
    expect(auditActionLabel("workspace.unsuspended")).toBe("Workspace restored");
    expect(auditActionLabel("flags.workspace_set")).toBe("Workspace flag changed");
    expect(auditActionLabel("note.added")).toBe("Note added");
    expect(auditActionLabel("brand_new.thing_done")).toBe("Brand new thing done");
    expect(AUDIT_ACTIONS_WITHOUT_REASON.has("note.added")).toBe(true);
    expect(auditFieldLabel("suspendedAt")).toBe("Suspended");
    expect(auditFieldLabel("resolvedAbuseEvents")).toBe("Abuse signals dismissed");
    expect(auditFieldLabel("override.value")).toBe("Override: Value");
    expect(auditFieldLabel("someNewField")).toBe("Some new field");
  });
  it("uses one word and one tone per state", () => {
    for (const s of ["failed", "refused", "bounced", "rejected", "dead"]) expect(statusTone(s)).toBe("bad");
    for (const s of ["waiting", "pending", "retrying", "past_due", "needs_attention"]) expect(statusTone(s)).toBe("warn");
    for (const s of ["ok", "active", "delivered", "done"]) expect(statusTone(s)).toBe("ok");
    for (const s of ["off", "none", "dismissed", undefined]) expect(statusTone(s)).toBe("neutral");
    expect(["pending", "running", "dead", "done"].map(jobStatusLabel)).toEqual(["Waiting", "Running", "Failed for good", "Done"]);
    expect([integrationLabel(true), integrationLabel(false)]).toEqual(["Connected", "Not connected"]);
  });
});

describe("dates", () => {
  const at = "2026-11-21T11:12:33.000Z"; // 22:12 in Sydney
  it("formats calendar days day first, never ISO or US order", () => {
    expect(formatDay(at, AU)).toBe("21 Nov 2026");
    expect(formatDay(at, UTC)).toBe("21 Nov 2026");
    expect(formatDay("2026-11-21T23:30:00Z", AU)).toBe("22 Nov 2026");
    expect(formatDay(null)).toBe(EMPTY);
    expect(formatDay("not a date")).toBe(EMPTY);
  });
  it("formats date and time to the minute, without seconds", () => {
    const s = formatDateTime(at, AU);
    expect(s).toMatch(/^21 Nov 2026, 10:12\s?pm$/);
    expect(s).not.toMatch(/:33/);
    expect(formatDateTime(undefined)).toBe(EMPTY);
  });
  it("says relative times against a fixed clock", () => {
    const now = Date.parse(at);
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 86_400_000, now)).toBe("1 day ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 days ago");
    expect(relativeTime(now + 4 * 3600_000, now)).toBe("in 4 h");
    expect(relativeTime(now - 30 * 86_400_000, now, UTC)).toBe("22 Oct 2026");
    expect(relativeTime(null, now)).toBe(EMPTY);
  });
  it("RelTime keeps the exact time in the title", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(at) + 5 * 60_000));
    const out = html(RelTime, { at });
    vi.useRealTimers();
    expect(out).toContain(">5 min ago<");
    expect(out).toContain(`dateTime="${at}"`);
    expect(out).toMatch(/title="21 Nov 2026, /);
    expect(html(RelTime, { at: null })).toContain(">None<");
  });
});

describe("components", () => {
  it("renders badges and links with one wording", () => {
    expect(html(Empty, {})).toContain(">None<");
    expect(html(StatusBadge, { state: "refused" })).toContain("bg-bad-soft");
    expect(html(StatusBadge, { state: "refused" })).toContain("Refused");
    expect(html(JobStatusBadge, { status: "dead" })).toContain("Failed for good");
    expect(html(OperatorRoleBadge, { role: "ops_support" })).toContain(">Support<");
    expect(html(OperatorRoleBadge, { role: "admin" })).toContain(">Owner<");
    expect(html(TwoStepBadge, { on: false })).toContain("Off");
    expect(html(TwoStepBadge, { on: true, long: true })).toContain("Two-step on");
    const ws = html(WorkspaceLink, { id: "org_1", name: "Acme", hint: "owner@acme.test" });
    expect(ws).toContain('href="/console/workspaces/org_1"');
    expect(ws).toContain('title="org_1"');
    expect(ws).toContain("owner@acme.test");
    expect(html(WorkspaceLink, { id: null, name: null })).toContain(">None<");
    expect(shortWorkspaceId("org_5f2c9a1be7d4")).toBe("5f2c9a1b");
    expect(workspaceHint("org_5f2c9a1be7d4", "owner@acme.test")).toBe("owner@acme.test");
    expect(workspaceHint("org_5f2c9a1be7d4", null)).toBe("5f2c9a1b");
    expect(workspaceHint(null, null)).toBeNull();
    // The hover text is the raw state unless the page gives its own.
    expect(html(StatusBadge, { state: "locked", label: "9 min" })).toContain('title="locked"');
    expect(html(StatusBadge, { state: "locked", label: "9 min", title: "Until 21 Nov 2026, 10:12 pm" })).toContain('title="Until 21 Nov 2026, 10:12 pm"');
    const p = html(PersonLink, { id: "usr_1", name: "Ada", email: "ada@x.test" });
    expect(p).toContain('href="/console/users/usr_1"');
    expect(p).toContain("ada@x.test");
    expect(html(EmptyRow, { children: "No keys yet." as ReactNode })).toContain("No keys yet.");
  });
  it("shows a calm no-access card for a 403 and the server's message otherwise", () => {
    const denied = new ApiError(403, "forbidden", "Your operator role can't do that.");
    expect(isNoAccess(denied)).toBe(true);
    expect(isNoAccess(new ApiError(403, "two_factor_required", "x"))).toBe(false);
    const out = html(LoadError, { error: denied, retry: () => {} });
    expect(out).toContain("You don&#x27;t have access to this page");
    expect(out).not.toContain("Try again");
    const failed = html(LoadError, { error: new ApiError(500, "internal", "Something went wrong on our side."), retry: () => {}, what: "operators" });
    expect(failed).toContain("Couldn&#x27;t load operators");
    expect(failed).toContain("Something went wrong on our side.");
    expect(failed).toContain("Try again");
    expect(consoleErrorMessage(new ApiError(0, "network", ""))).toMatch(/^Couldn't reach Multies/);
  });
  it("shows dates and booleans plainly in a change", () => {
    expect(showValue(null)).toBe(EMPTY);
    expect(showValue(true)).toBe("Yes");
    expect(showValue("2026-11-21T11:12:44.419Z")).toMatch(/Nov 2026, /);
    expect(showValue("QA role probe")).toBe("QA role probe");
  });
  it("sorts text A to Z and dates newest first on the first click", () => {
    expect(firstSortDir({ sort: "name" })).toBe("asc");
    expect(firstSortDir({ sort: "email" })).toBe("asc");
    expect(firstSortDir({ sort: "createdAt" })).toBe("desc");
    expect(firstSortDir({ sort: "attempts" })).toBe("desc");
    expect(firstSortDir({ sort: "plan", align: "right" })).toBe("desc");
    expect(firstSortDir({ sort: "createdAt", sortFirst: "asc" })).toBe("asc");
  });
});

describe("console reads", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps the server's message on a 500 and makes one request only", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "internal", message: "Something went wrong on our side." } }), { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const err = await consoleGet("/console/overview").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe("Something went wrong on our side.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("answers a 403 with its code and an empty 502 with a plain line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "forbidden", message: "Your operator role can't do that." } }), { status: 403 })));
    const denied = (await consoleGet("/console/operators").catch((e: unknown) => e)) as ApiError;
    expect([denied.status, denied.code]).toEqual([403, "forbidden"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    const bad = (await consoleGet("/console/operators").catch((e: unknown) => e)) as ApiError;
    expect(bad.message).toBe("Multies had a problem answering. Try again in a moment.");
  });
  it("retries only a request that never reached the server, once", () => {
    expect(consoleRetry(0, new ApiError(500, "internal", "x"))).toBe(false);
    expect(consoleRetry(0, new ApiError(403, "forbidden", "x"))).toBe(false);
    expect(consoleRetry(0, new ApiError(0, "network", "x"))).toBe(true);
    expect(consoleRetry(1, new ApiError(0, "network", "x"))).toBe(false);
  });
});
