/**
 * 1.10.7: Inbox tabs, Move to a tab, Snoozed, labels and mail rules on the phone, plus the small native things:
 * Copy text, Copy link, Share and Translate from a long press, with a "Copied" toast. Words match the web.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Linking, Platform, Share } from "react-native";
import * as Clipboard from "expo-clipboard";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import {
  activeTab, backLabel, checkDraft, countLabel, describeActions, describeConditions, draftOk, emptyDraft, newAction, phoneEditable, ruleSummary, runProblem,
  sendsMail, tabA11yLabel, toInput, type MailRule,
} from "@/lib/mail-rules";
import {
  clearQuickToast, copyToClipboard, currentQuickToast, firstLink, quickOptions, runQuickAction, shareContent, translateText, displayUrl,
} from "@/lib/quick-actions";
import { menuOptions } from "@/components/mail-actions";
import { postQuickTarget } from "@/lib/social";
import type { MessageSummary } from "@/api/types";

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
  Link: ({ children }: { children: ReactNode }) => children,
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

const rule = (o: Partial<MailRule> = {}): MailRule => ({
  id: "r1", name: "Invoices", mailboxId: "mbx", match: "all", conditions: [{ field: "subject", value: "invoice" }], actions: [{ kind: "label", label: "Invoices" }, { kind: "archive" }],
  enabled: true, position: 0, runCount: 0, lastRunAt: null, lastError: null, createdAt: "", updatedAt: "", ...o,
});

describe("inbox tabs", () => {
  const tabs = [{ id: "primary", name: "Primary", unread: 3, builtIn: true }, { id: "updates", name: "Updates", unread: 120, builtIn: true }];
  it("opens the remembered tab while it exists, else the style's first", () => {
    expect(activeTab(tabs, "updates")).toBe("updates");
    expect(activeTab(tabs, "promotions", "primary")).toBe("primary");
    expect(activeTab(tabs, null)).toBe("primary");
    expect(activeTab([], "updates")).toBe("");
  });
  it("shows counts with 99+ and reads them out", () => {
    expect(countLabel(0)).toBe("");
    expect(countLabel(7)).toBe("7");
    expect(countLabel(100)).toBe("99+");
    expect(tabA11yLabel(tabs[0])).toBe("Primary, 3 unread");
    expect(tabA11yLabel(tabs[1])).toBe("Updates, more than 99 unread");
    expect(tabA11yLabel({ ...tabs[0], unread: 0 })).toBe("Primary");
  });
  it("says when snoozed mail comes back", () => {
    const now = new Date(2026, 9, 31, 10, 0).getTime(); // Sat 31 Oct, 10 am local
    expect(backLabel(new Date(2026, 9, 31, 16, 30).toISOString(), now)).toBe("Today 4:30 pm");
    expect(backLabel(new Date(2026, 10, 1, 8, 0).toISOString(), now)).toBe("Tomorrow 8:00 am");
    expect(backLabel(new Date(2026, 10, 2, 8, 0).toISOString(), now)).toBe("Mon 8:00 am");
    expect(backLabel(new Date(2026, 10, 20, 8, 0).toISOString(), now)).toBe("20 Nov 8:00 am");
  });
});

describe("mail rules", () => {
  it("describes a rule the way the web does", () => {
    expect(describeConditions(rule())).toBe('Subject contains "invoice"');
    expect(describeConditions(rule({ match: "any", conditions: [{ field: "from", value: "acme" }, { field: "hasAttachment", value: "" }] }))).toBe('From contains "acme" or has an attachment');
    expect(describeActions(rule().actions)).toBe("Add the label Invoices, then archive");
    expect(ruleSummary(rule({ actions: [{ kind: "move_to_tab", tab: "updates" }] }), () => "Updates")).toBe('Subject contains "invoice": move to Updates');
  });
  it("keeps forward and saved reply rules on the web", () => {
    const fwd = rule({ actions: [{ kind: "forward", to: "a@b.co" }] });
    expect(sendsMail(fwd)).toBe(true);
    expect(phoneEditable(fwd)).toBe(false);
    expect(sendsMail(rule())).toBe(false);
    expect(phoneEditable(rule())).toBe(true);
  });
  it("checks the form before sending, in plain words", () => {
    const d = emptyDraft("mbx");
    const p = checkDraft(d);
    expect(p.name).toBe("Name the rule.");
    expect(p.condition?.[0]).toBe("This condition needs a value.");
    expect(p.actions).toBe("Add at least one action.");
    expect(draftOk(p)).toBe(false);
    const ok = { ...d, name: " Invoices ", conditions: [{ field: "subject" as const, value: " invoice " }, { field: "hasAttachment" as const, value: "x" }], actions: [newAction("label"), newAction("archive"), newAction("archive")] };
    const p2 = checkDraft(ok);
    expect(p2.action?.[0]).toBe("Name the label.");
    expect(p2.action?.[2]).toBe("This action is already in the rule.");
    const good = { ...ok, actions: [{ kind: "label" as const, label: " Bills " }, newAction("archive")] };
    expect(draftOk(checkDraft(good))).toBe(true);
    expect(toInput(good)).toEqual({ name: "Invoices", mailboxId: "mbx", match: "all", enabled: true,
      conditions: [{ field: "subject", value: "invoice" }, { field: "hasAttachment", value: "" }], actions: [{ kind: "label", label: "Bills" }, { kind: "archive" }] });
    expect(checkDraft({ ...good, actions: [{ kind: "label", label: "tab:x" }] }).action?.[0]).toBe("Pick another label name.");
    expect(checkDraft({ ...good, actions: [{ kind: "forward", to: "a@b.co" }] }).action?.[0]).toBe("Change this action on the web.");
  });
  it("puts a run's problem in plain words", () => {
    expect(runProblem({ id: "1", messageId: null, from: null, subject: null, status: "ok", steps: [], createdAt: "" })).toBeNull();
    expect(runProblem({ id: "1", messageId: null, from: null, subject: null, status: "partial", steps: [{ action: "star", ok: false, detail: "the mail was deleted first" }], createdAt: "" }))
      .toBe("Star didn't work: the mail was deleted first");
  });
});

describe("quick actions", () => {
  beforeEach(() => { (Clipboard.setStringAsync as jest.Mock).mockClear(); clearQuickToast(); });
  it("offers Open, Copy link and Share on a link, and the content set on a mail", () => {
    expect(quickOptions({ kind: "link", title: "Link", link: "https://a.co/x" }).map((o) => o.label)).toEqual(["Open", "Copy link", "Share"]);
    expect(quickOptions({ kind: "link", title: "Link", link: "mailto:a@b.co" }).map((o) => o.label)).toEqual(["Write an email", "Copy address", "Share"]);
    expect(quickOptions({ title: "Mail", text: "Hello", link: "https://a.co" }).map((o) => o.label)).toEqual(["Copy text", "Copy link", "Share", "Translate"]);
    expect(quickOptions({ title: "Mail", text: "Hello" }).map((o) => o.label)).toEqual(["Copy text", "Share", "Translate"]);
    expect(quickOptions({ title: "Post", link: "https://fb.com/1", linkLabel: "Copy post link" }).map((o) => o.label)).toEqual(["Copy post link", "Share"]);
  });
  it("finds the first web link and shows addresses without the scheme", () => {
    expect(firstLink("Write to help@multies.si or see https://multies.si/a.")).toBe("https://multies.si/a");
    expect(firstLink("no links")).toBeNull();
    expect(displayUrl("https://multies.si/")).toBe("multies.si");
    expect(displayUrl("mailto:a@b.co")).toBe("a@b.co");
  });
  it("copies with a Copied toast", async () => {
    await copyToClipboard("Hi there");
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("Hi there");
    expect(currentQuickToast()?.text).toBe("Copied");
    await runQuickAction("copy-link", { title: "Link", kind: "link", link: "mailto:a@b.co" });
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith("a@b.co");
    expect(currentQuickToast()?.text).toBe("Address copied");
  });
  it("says so when the copy fails", async () => {
    (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(new Error("no"));
    expect(await copyToClipboard("x")).toBe(false);
    expect(currentQuickToast()).toMatchObject({ text: "Couldn't copy that", tone: "bad" });
  });
  it("shares text with its link, and copies when there is no share sheet", async () => {
    const spy = jest.spyOn(Share, "share").mockResolvedValueOnce({ action: "sharedAction", activityType: undefined });
    await shareContent({ text: "Hello", link: "https://a.co" });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: "Hello\n\nhttps://a.co" }));
    spy.mockRejectedValueOnce(new Error("not supported"));
    await shareContent({ text: "Hello" });
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith("Hello");
    spy.mockRestore();
  });
  it("translates with the system on Android, else the share sheet, never a paid service", async () => {
    const os = Platform.OS;
    Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
    const intent = jest.spyOn(Linking, "sendIntent").mockResolvedValueOnce(undefined as never);
    expect(await translateText("Bonjour")).toBe("intent");
    expect(intent).toHaveBeenCalledWith("android.intent.action.TRANSLATE", [{ key: "android.intent.extra.TEXT", value: "Bonjour" }]);
    intent.mockRejectedValueOnce(new Error("no app"));
    const share = jest.spyOn(Share, "share").mockResolvedValueOnce({ action: "sharedAction", activityType: undefined });
    expect(await translateText("Bonjour")).toBe("share");
    Object.defineProperty(Platform, "OS", { value: os, configurable: true });
    intent.mockRestore(); share.mockRestore();
  });
  it("has the small things on a mail's long press, with Trash last", () => {
    const m = { id: "m", threadId: "t", subject: "Hi", isStarred: false, isRead: true, labels: ["Bills"] } as unknown as MessageSummary;
    const ids = menuOptions(m, true).map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(["move-tab", "labels", "copy-text", "copy-link", "share", "translate"]));
    expect(ids[ids.length - 1]).toBe("mail-trash");
    expect(menuOptions(m, false).map((o) => o.id)).not.toContain("move-tab");
    expect(menuOptions(m, true).find((o) => o.id === "labels")?.hint).toBe("Bills");
  });
  it("copies a post's link from the network it went to", () => {
    const t = postQuickTarget({ id: "p", text: "Testing. https://fintex.au", imageUrl: null, status: "done", runAt: "", createdAt: "", createdBy: null,
      targets: [{ accountId: "a", app: "facebook", label: null, target: null, targetName: null, status: "sent", url: "https://www.facebook.com/1/posts/2", error: null, sentAt: null }] });
    expect(t).toMatchObject({ title: "Testing. https://fintex.au", link: "https://www.facebook.com/1/posts/2", linkLabel: "Copy post link", subtitle: "On Facebook" });
  });
  it("never turns off paste or the system menu on a text box", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx?$/.test(f) ? [join(d, f)] : []));
    const bad = walk(join(__dirname, "..", "src")).filter((f) => /contextMenuHidden|onPaste=\{\s*\(\)\s*=>\s*false/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});

describe("sample workspace answers like the server", () => {
  it("sorts into tabs, teaches a sender, labels, snoozes and runs rules", async () => {
    const t = new SampleTransport();
    const tabs = await t.request<{ tabs: { id: string; unread: number }[]; style: string }>("GET", "/mail/splits");
    expect(tabs.style).toBe("categories");
    expect(tabs.tabs.map((x) => x.id)).toEqual(["primary", "updates", "promotions"]);
    const promo = await t.request<{ messages: { id: string }[] }>("GET", "/mail/messages?folder=inbox&split=promotions");
    expect(promo.messages.map((m) => m.id)).toContain("msg_p1");
    await t.request("POST", "/mail/splits/teach", { messageId: "msg_p1", tab: "primary", sender: true });
    const primary = await t.request<{ messages: { id: string }[] }>("GET", "/mail/messages?folder=inbox&split=primary");
    expect(primary.messages.map((m) => m.id)).toContain("msg_p1");
    await t.request("POST", "/mail/labels", { threadId: "thr_1", label: "Markets" });
    const labelled = await t.request<{ messages: { id: string; labels?: string[] }[] }>("GET", "/mail/messages?folder=inbox&label=Markets");
    expect(labelled.messages.map((m) => [m.id, m.labels])).toEqual([["msg_1", ["Markets"]]]);
    const snoozed = await t.request<{ items: { id: string; message: unknown }[] }>("GET", "/mail-schedules?view=snoozed");
    expect(snoozed.items).toHaveLength(1);
    await t.request("DELETE", `/mail-schedules/${snoozed.items[0].id}`);
    expect((await t.request<{ items: unknown[] }>("GET", "/mail-schedules?view=snoozed")).items).toHaveLength(0);
    const test = await t.request<{ matched: number }>("POST", "/mail/rules/test", { mailboxId: "mbx_mia", match: "all", conditions: [{ field: "subject", value: "invoice" }] });
    expect(test.matched).toBeGreaterThan(0);
    const made = await t.request<{ rule: MailRule }>("POST", "/mail/rules", { name: "Bakery", mailboxId: "mbx_mia", match: "all", conditions: [{ field: "domain", value: "bondibakehouse.com.au" }], actions: [{ kind: "label", label: "Bakery" }], enabled: true });
    expect((await t.request<{ ran: number }>("POST", `/mail/rules/${made.rule.id}/run-recent`, {})).ran).toBe(1);
    await t.request("PATCH", `/mail/rules/${made.rule.id}`, { enabled: false });
    expect((await t.request<{ rule: MailRule }>("GET", `/mail/rules/${made.rule.id}`)).rule.enabled).toBe(false);
  });
});

describe("screens", () => {
  const wrap = (ui: ReactNode) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}><SessionProvider initialMode="sample">{ui}</SessionProvider></QueryClientProvider>);
  };
  it("Inbox shows the tabs with counts and switches by tap", async () => {
    const Inbox = require("@/app/(tabs)/inbox").default;
    await wrap(<Inbox />);
    await waitFor(() => expect(screen.getByTestId("inbox-tab-updates")).toBeTruthy());
    expect(screen.getByLabelText(/^Primary, \d+ unread$/)).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId("inbox-tab-updates")); });
    await waitFor(() => expect(screen.getByText("Your payout of A$2,140.60 is on its way")).toBeTruthy());
    expect(screen.queryByText("Wholesale order for Saturday markets")).toBeNull();
  });
  it("Snoozed lists mail with when it comes back", async () => {
    const Inbox = require("@/app/(tabs)/inbox").default;
    await wrap(<Inbox />);
    await waitFor(() => expect(screen.getByLabelText(/^Snoozed/)).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByLabelText(/^Snoozed/)); });
    await waitFor(() => expect(screen.getByText("Cup samples for the new kiosk")).toBeTruthy());
    expect(screen.getByText(/^Back Tomorrow/)).toBeTruthy();
  });
  it("Mail settings lists rules with switches and keeps sending rules on the web", async () => {
    const MailSettings = require("@/app/mail-settings").default;
    await wrap(<MailSettings />);
    await waitFor(() => expect(screen.getByText("Market bookings to Sam")).toBeTruthy());
    expect(screen.getByText(/Change it on the web/)).toBeTruthy();
    expect(screen.getByTestId("rule-mrl_s1-switch")).toBeTruthy();
    expect(screen.getByTestId("tab-style-categories")).toBeTruthy();
  });
  it("New rule says what is missing before it saves", async () => {
    mockParams = { id: "new" };
    const Rule = require("@/app/mail-rule/[id]").default;
    await wrap(<Rule />);
    await waitFor(() => expect(screen.getByTestId("rule-save")).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId("rule-save")); });
    await waitFor(() => expect(screen.getByText("Name the rule.")).toBeTruthy());
    expect(screen.getByText("Add at least one action.")).toBeTruthy();
  });
});
