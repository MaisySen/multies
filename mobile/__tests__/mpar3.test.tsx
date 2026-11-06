/** MPAR3: Calendar, meeting notes, compose extras, folders and bulk select, the shared inbox, and their words. */
import fs from "fs";
import path from "path";
import { webcrypto } from "crypto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { bundles, setLangForTests, tr } from "@/i18n";
import { placeholders } from "@/i18n/core";
import { readPref, resetPrefsForTests } from "@/lib/startup-prefs";
import { paletteFor } from "@/theme";
import {
  byDay, composeFileProblem, eventColor, cleanLayers, encryptSecretText, eventDays, eventTitle, icsProblem, insertAt, localMoment, localWhen, meetingIdOf, monthGrid,
  ownFolders, packSecretText, secretLink, taskIdOf, toggleId, transcriptLines, windowFor, weekOf, type CalendarEvent, type SealFn,
} from "@/lib/mpar3";

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

const SRC = path.join(__dirname, "..", "src");
const TOUCHED = [
  "app/calendar.tsx", "app/calendar-settings.tsx", "app/meeting-notes/[id].tsx", "app/one-inbox.tsx", "app/meetings.tsx", "app/compose.tsx", "app/(tabs)/inbox.tsx",
  "app/settings.tsx", "app/_layout.tsx", "components/compose-extras.tsx", "components/mail-bulk.tsx", "components/thread-team.tsx", "components/meetings.tsx",
  "components/mpar3-ui.tsx", "lib/mpar3.ts", "app/(tabs)/today.tsx", "app/(tabs)/tasks.tsx",
];
const DYNAMIC = ["m.cal.view_month", "m.cal.view_week", "m.cal.view_agenda", "m.compose3.preset_later_today", "m.compose3.preset_tomorrow", "m.compose3.preset_next_week",
  "m.compose3.expires_3600", "m.compose3.expires_86400", "m.compose3.expires_604800", "m.team.status_open", "m.team.status_waiting", "m.team.status_done",
  "m.one.view_inbox", "m.one.view_later", "m.one.view_done"];
const DEVANAGARI = /[\u0900-\u097F]/;
const text = (v: unknown) => (typeof v === "string" ? v : Object.values(v as Record<string, string>).join(" "));

let transport: SampleTransport;
async function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}
beforeEach(() => { transport = new SampleTransport(); mockPush.mockClear(); mockParams = {}; resetPrefsForTests(); });
afterEach(() => setLangForTests("en"));

describe("words", () => {
  const used = new Set<string>(DYNAMIC);
  const MINE = /^m\.(cal|calset|notes|compose3|m3x|bulk|folders|team|one)\./;
  for (const f of TOUCHED) for (const m of fs.readFileSync(path.join(SRC, f), "utf8").matchAll(/\btr\(\s*"([^"]+)"/g)) if (MINE.test(m[1])) used.add(m[1]);
  it("has every key in English, Nepali and Hindi with the same placeholders", () => {
    expect(used.size).toBeGreaterThan(200);
    for (const k of used) {
      for (const l of ["en", "ne", "hi"] as const) expect([k, l, bundles[l][k] !== undefined]).toEqual([k, l, true]);
      for (const l of ["ne", "hi"] as const) {
        expect([k, l, placeholders(bundles[l][k]).sort()]).toEqual([k, l, placeholders(bundles.en[k]).sort()]);
        expect([k, l, DEVANAGARI.test(text(bundles[l][k]))]).toEqual([k, l, true]);
      }
    }
  });
  it("uses no dash punctuation in the new lines", () => {
    for (const k of used) for (const l of ["en", "ne", "hi"] as const) expect([k, /[\u2013\u2014]| - /.test(text(bundles[l][k]))]).toEqual([k, false]);
  });
  it("speaks Nepali and Hindi on the calendar and composer", () => {
    setLangForTests("ne");
    expect(tr("m.cal.view_month")).toBe("महिना");
    expect(tr("m.compose3.n_files", { count: 2 })).toContain("२");
    setLangForTests("hi");
    expect(tr("m.cal.due")).toBe("नियत तारीख़");
  });
});

describe("calendar helpers", () => {
  it("lays out a Monday first month of six weeks", () => {
    const g = monthGrid(2026, 10);
    expect(g).toHaveLength(42);
    expect(g[0].date.getDay()).toBe(1);
    expect(g.filter((d) => d.inMonth)).toHaveLength(30);
    expect(weekOf(new Date(2026, 10, 5)).map((d) => d.getDay())).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
  it("asks the server for the whole visible grid", () => {
    const w = windowFor("month", new Date(2026, 10, 15));
    expect(new Date(w.to).getTime() - new Date(w.from).getTime()).toBeGreaterThanOrEqual(41 * 86_400_000);
  });
  it("puts all day and timed events on their days and hides hidden layers", () => {
    const ev = (o: Partial<CalendarEvent>): CalendarEvent => ({ id: "x", kind: "meeting", title: "T", start: "2026-11-05T09:00:00", end: "2026-11-05T10:00:00", allDay: false, ...o } as CalendarEvent);
    expect(eventDays(ev({ allDay: true, start: "2026-11-05", end: "2026-11-07" }))).toEqual(["2026-11-05", "2026-11-06"]);
    const m = byDay([ev({}), ev({ id: "e", kind: "external", sourceId: "cal_family" })], ["cal_family"]);
    expect(m.get("2026-11-05")).toHaveLength(1);
    expect(eventTitle({ kind: "due", title: "Due: Send invoice (T-12)" })).toBe("Send invoice (T-12)");
    expect(taskIdOf({ kind: "due", id: "task:t1" })).toBe("t1");
    expect(meetingIdOf({ kind: "meeting", id: "m1:2026-11-05T09:00:00Z" })).toBe("m1");
    expect(cleanLayers(["due", 4, "cal_x"])).toEqual(["due", "cal_x"]);
  });
  it("checks typed dates, times and calendar links", () => {
    expect(localMoment("2026-11-05", "09:30")?.getHours()).toBe(9);
    expect(localMoment("2026-02-30", "09:30")).toBeNull();
    expect(localMoment("2026-11-05", "25:00")).toBeNull();
    expect(icsProblem("")).toBeTruthy();
    expect(icsProblem("ftp://x")).toBeTruthy();
    expect(icsProblem("webcal://example.com/a.ics")).toBeNull();
  });
});

describe("compose helpers", () => {
  it("keeps to 10 files and 20 MB", () => {
    expect(composeFileProblem({ name: "a.pdf", size: 0 }, [])).toBeTruthy();
    expect(composeFileProblem({ name: "a.pdf", size: 21 * 1024 * 1024 }, [])).toBeTruthy();
    expect(composeFileProblem({ name: "a.pdf", size: 1000 }, Array.from({ length: 10 }, () => ({ size: 1 })))).toBeTruthy();
    expect(composeFileProblem({ name: "a.pdf", size: 1000 }, [])).toBeNull();
  });
  it("inserts a saved reply at the cursor and checks send later times", () => {
    const ins = insertAt("Hi\n\nThanks", { start: 4, end: 4 }, "Body");
    expect(ins.text.startsWith("Hi\n\nBody")).toBe(true);
    expect(ins.text.endsWith("Thanks")).toBe(true);
    expect(ins.text.slice(0, ins.cursor)).toMatch(/Body\s*$/);
    expect(localWhen("2020-01-01", "09:00")).toHaveProperty("error");
    expect(localWhen("2099-01-01", "09:00")).toEqual({ local: "2099-01-01T09:00" });
  });
  it("locks a secret the way the web opens it", async () => {
    const subtle = webcrypto.subtle;
    const seal: SealFn = async (plain, key, iv) => {
      const k = await subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt"]);
      const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, k, new Uint8Array(plain)));
      const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length); return out;
    };
    const random = (n: number) => webcrypto.getRandomValues(new Uint8Array(n));
    const { ciphertext, key } = await encryptSecretText("hunter2 is the wifi", seal, random);
    const b = (s: string) => Uint8Array.from(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    const all = b(ciphertext);
    const k = await subtle.importKey("raw", b(key), "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, k, all.slice(12)));
    expect(Buffer.from(plain).equals(Buffer.from(packSecretText("hunter2 is the wifi")))).toBe(true);
    const len = new DataView(plain.buffer).getUint32(0);
    expect(JSON.parse(Buffer.from(plain.slice(4, 4 + len)).toString())).toEqual({ k: "text" });
    expect(Buffer.from(plain.slice(4 + len)).toString()).toBe("hunter2 is the wifi");
    expect(secretLink("https://x/s/abc", key)).toBe(`https://x/s/abc#${key}`);
  });
});

describe("mail helpers", () => {
  it("lists only synced folders of your own and caps a selection", () => {
    expect(ownFolders({ folders: [{ key: "f:A", path: "A", name: "A", role: null, synced: true }, { key: "f:S", path: "Sent", name: "Sent", role: "sent", synced: true }, { key: "f:B", path: "B", name: "B", role: null, synced: false }], maxExtra: 5 }).map((f) => f.key)).toEqual(["f:A"]);
    expect(toggleId(toggleId([], "a"), "a")).toEqual([]);
    const lines = transcriptLines("[00:01] Hello\nThere");
    expect(lines[0].at).toBe("00:01");
    expect(lines.map((l) => l.text).join(" ")).toContain("There");
  });
});

describe("sample workspace", () => {
  it("answers every MPAR3 path", async () => {
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString(), to = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const ev = await transport.request<{ events: CalendarEvent[] }>("GET", `/calendar/events?from=${from}&to=${to}`);
    expect(ev.events.some((e) => e.kind === "meeting")).toBe(true);
    expect(ev.events.some((e) => e.kind === "due")).toBe(true);
    await transport.request("PATCH", "/calendar/sources/cal_family", { enabled: false });
    const ev2 = await transport.request<{ events: CalendarEvent[] }>("GET", `/calendar/events?from=${from}&to=${to}`);
    expect(ev2.events.some((e) => e.sourceId === "cal_family")).toBe(false);
    const feed = await transport.request<{ feed: { url?: string; enabled: boolean } }>("POST", "/calendar/feed", { includeTasks: true });
    expect(feed.feed.enabled).toBe(true);
    expect(feed.feed.url).toMatch(/^https:/);
    const snips = await transport.request<{ snippets: unknown[] }>("GET", "/mail-snippets");
    expect(snips.snippets.length).toBe(3);
    const r = await transport.request<{ body: string }>("POST", "/mail-snippets/snp_1/render", { to: "sam@example.com" });
    expect(r.body).not.toContain("{first_name}");
    const sec = await transport.request<{ secret: { url: string } }>("POST", "/tools/secrets", { kind: "text", ciphertext: "abc", label: null, passphrase: false, maxViews: 1, expiresInSeconds: 3600, notify: false });
    expect(sec.secret.url).toMatch(/^https:/);
    const st = await transport.request<{ state: { assignee: unknown } }>("POST", "/threads/thr_1/assign", { userId: null });
    expect(st.state.assignee).toBeNull();
    const one = await transport.request<{ items: { id: string; kind: string }[] }>("GET", "/one-inbox?lane=important&view=inbox");
    await transport.request("POST", "/one-inbox/act", { action: "done", items: [{ kind: one.items[0].kind, id: one.items[0].id }] });
    const one2 = await transport.request<{ items: { id: string }[] }>("GET", "/one-inbox?lane=important&view=inbox");
    expect(one2.items.length).toBe(one.items.length - 1);
  });
});

jest.setTimeout(60_000);
describe("screens", () => {
  it("Calendar switches views and keeps the pick", async () => {
    const Calendar = require("@/app/calendar").default;
    const r = await wrap(<Calendar />);
    expect(await r.findByTestId("calendar-screen", {}, { timeout: 10000 })).toBeTruthy();
    await fireEvent.press(await r.findByLabelText(tr("m.cal.view_agenda"), {}, { timeout: 10000 }));
    await waitFor(() => expect(r.getAllByText(/./).length).toBeGreaterThan(5), { timeout: 10000 });
  });
  it("Calendar settings lists other calendars", async () => {
    const S = require("@/app/calendar-settings").default;
    const r = await wrap(<S />);
    expect(await r.findByText("Family", {}, { timeout: 10000 })).toBeTruthy();
    expect(r.getByText("Public holidays")).toBeTruthy();
  });
  it("One inbox marks an item done", async () => {
    const One = require("@/app/one-inbox").default;
    const r = await wrap(<One />);
    const done = await r.findByTestId("one-done-msg_1", {}, { timeout: 10000 });
    await fireEvent.press(done);
    await waitFor(() => expect(r.queryByTestId("one-msg_1")).toBeNull(), { timeout: 10000 });
  });
  it("a shared thread shows assign, status and team notes", async () => {
    const { ThreadTeam } = require("@/components/thread-team");
    const r = await wrap(<ThreadTeam threadId="thr_1" />);
    expect(await r.findByTestId("thread-team", {}, { timeout: 10000 })).toBeTruthy();
    expect(await r.findByTestId("comment-cmt_1", {}, { timeout: 10000 })).toBeTruthy();
    await fireEvent.changeText(r.getByTestId("team-note"), "Called them");
    await fireEvent.press(r.getByTestId("team-note-add"));
    expect(await r.findByText("Called them", {}, { timeout: 10000 })).toBeTruthy();
  });
  it("compose fills in a saved reply", async () => {
    const Compose = require("@/app/compose").default;
    const r = await wrap(<Compose />);
    await fireEvent.press(await r.findByTestId("compose-replies", {}, { timeout: 10000 }));
    await fireEvent.press(await r.findByTestId("snippet-snp_1", {}, { timeout: 10000 }));
    await waitFor(() => expect(String(r.getByTestId("body").props.value)).toContain("your order is in"), { timeout: 10000 });
    expect(r.getByTestId("compose-later")).toBeTruthy();
    expect(r.getByTestId("compose-attach")).toBeTruthy();
  });
});

describe("language, saved picks and theme", () => {
  it("shows Calendar settings in Nepali", async () => {
    setLangForTests("ne");
    const S = require("@/app/calendar-settings").default;
    const r = await wrap(<S />);
    expect(await r.findByText("अरू क्यालेन्डर", {}, { timeout: 10000 })).toBeTruthy();
  });
  it("keeps the calendar view on the phone", async () => {
    const Calendar = require("@/app/calendar").default;
    const r = await wrap(<Calendar />);
    await fireEvent.press(await r.findByLabelText(tr("m.cal.view_week"), {}, { timeout: 10000 }));
    await waitFor(() => expect(readPref("calendar.view")).toBe("week"));
  });
  it("colours meetings with the accent in every look", () => {
    const blue = paletteFor("light", "blue"), forest = paletteFor("dark", "forest");
    expect(eventColor({ kind: "meeting", color: null }, blue)).toBe(blue.brand);
    expect(eventColor({ kind: "meeting", color: null }, forest)).toBe(forest.brand);
    expect(eventColor({ kind: "external", color: "#AF52DE" }, forest)).toBe("#AF52DE");
    expect(blue.brand).not.toBe(forest.brand);
  });
});
