/** M4: app lock rules, invoice and booking helpers, the Today summary and the new native routes. */
import { backoffSeconds, hashPin, sameHash, shouldLockOnReturn, validPin, checkPin, setPin, getLockSettings, turnOffLock, MAX_FAILS } from "@/lib/app-lock";
import { bookingDays, dueLine, money, qty, shortLabel, stateOf } from "@/lib/m4";
import { qs } from "@/lib/m4-queries";
import { nativeRoute } from "@/lib/nav-menu";
import { m4Route, sampleM4 } from "@/sample/m4";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn() }, useFocusEffect: jest.fn(), useLocalSearchParams: () => ({}) }));
jest.mock("expo-crypto", () => {
  const { createHash, randomBytes } = jest.requireActual("crypto");
  return { CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: async (_a: string, s: string) => createHash("sha256").update(s).digest("hex"), getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});

describe("app lock", () => {
  it("takes 4 to 6 digits only", () => {
    expect(["1234", "123456"].every(validPin)).toBe(true);
    expect(["123", "1234567", "12a4", ""].some(validPin)).toBe(false);
  });
  it("backs off after 5 wrong PINs", () => {
    expect([1, 4, 5, 6, 7, 8, 12].map(backoffSeconds)).toEqual([0, 0, 30, 60, 300, 900, 900]);
  });
  it("locks on return by the chosen time", () => {
    expect(shouldLockOnReturn(0, "0")).toBe(true);
    expect(shouldLockOnReturn(59_000, "60")).toBe(false);
    expect(shouldLockOnReturn(301_000, "300")).toBe(true);
    expect(shouldLockOnReturn(10 * 60_000, "900")).toBe(false);
  });
  it("salts and stretches the hash", async () => {
    const d = async (s: string) => `h(${s.length})`;
    expect(await hashPin("1234", "aa", 3, d)).toBe(await hashPin("1234", "aa", 3, d));
    const a = await hashPin("1234", "salt1", 50), b = await hashPin("1234", "salt2", 50), c = await hashPin("1235", "salt1", 50);
    expect(a).not.toBe(b); expect(a).not.toBe(c); expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sameHash(a, a)).toBe(true); expect(sameHash(a, b)).toBe(false); expect(sameHash("ab", "abc")).toBe(false);
  });
  it("checks the PIN, never stores it, backs off and signs out at the limit", async () => {
    await setPin("2468");
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    const raw = JSON.stringify(store ?? {});
    expect(raw.includes("2468")).toBe(false);
    expect(await checkPin("2468")).toEqual({ ok: true });
    let now = Date.now(), last: Awaited<ReturnType<typeof checkPin>> | null = null;
    for (let i = 0; i < MAX_FAILS; i++) { last = await checkPin("0000", now); now += 16 * 60_000; }
    expect(last && !last.ok && last.signOut).toBe(true);
    await turnOffLock();
    expect((await getLockSettings()).hasPin).toBe(false);
  });
});

describe("M4 screens", () => {
  it("formats invoices", () => {
    expect(money(123450)).toBe("$1,234.50");
    expect(qty(4500)).toBe("4.5");
    expect(stateOf("overdue")).toEqual({ label: "Overdue", tone: "bad" });
    expect(dueLine({ state: "overdue", dueDate: "2026-11-01" }, "2026-11-04")).toBe("3 days overdue");
    expect(dueLine({ state: "unpaid", dueDate: "2026-11-04" }, "2026-11-04")).toBe("Due today");
    expect(dueLine({ state: "paid", dueDate: "2026-11-01" }, "2026-11-04")).toBeNull();
  });
  it("groups bookings by day and drops cancelled ones", () => {
    const now = new Date("2026-11-03T01:00:00Z");
    const b = (id: string, at: string, status: "confirmed" | "cancelled" = "confirmed") => ({ id, startsAt: at, endsAt: at, durationMin: 30, name: id, email: "", note: null, status, meetingUrl: null });
    const g = bookingDays([b("b", "2026-11-04T02:00:00Z"), b("a", "2026-11-03T03:00:00Z"), b("x", "2026-11-03T04:00:00Z", "cancelled")], now);
    expect(g.map((d) => [d.day, d.items.map((i) => i.id)])).toEqual([["Today", ["a"]], ["Tomorrow", ["b"]]]);
  });
  it("builds query strings and short labels", () => {
    expect(qs({ kind: "invoice", state: "", limit: "50" })).toBe("kind=invoice&limit=50");
    expect(shortLabel("https://mul.ti/deck")).toBe("mul.ti/deck");
  });
  it("opens invoices, scheduling and links in the app", () => {
    expect(nativeRoute("/app/contacts/invoices")).toBe("/invoices");
    expect(nativeRoute("/app/contacts/invoices/inv_9")).toBe("/invoice/inv_9");
    expect(nativeRoute("/app/scheduling")).toBe("/scheduling");
    expect(nativeRoute("/app/tools/links")).toBe("/links");
  });
  it("has sample answers for the new screens", () => {
    const s = sampleM4(Date.now());
    const open = m4Route(s, "GET", "/invoices/docs", { state: "open" }) as { items: unknown[] };
    expect(open.items).toHaveLength(3);
    expect((m4Route(s, "GET", "/invoices/docs/inv_1") as { doc: { lines: unknown[] } }).doc.lines).toHaveLength(2);
    expect(m4Route(s, "POST", "/links")).toBeUndefined();
  });
});
