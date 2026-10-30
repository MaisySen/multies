import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "@/lib/session";
import { optionProblem, optionShown, resultExt, runsOnPhone, type ToolDef } from "@/lib/tools";
import {
  buildEntries, entriesForFile, middleTruncate, noRunsLine, offlineDelay, recentEntries, resetWhen, runsLeft, runsLeftLabel, savedLine, searchEntries, sectionsOf, waitLine,
} from "@/lib/tool-directory";
import { attachToNewEmail, carryFile, clearRun, loadRun, recentKeys, rememberRecent, resetToolRunCache, saveRun, takeCarried, takePendingToolFiles, tokenFromDownloadUrl } from "@/lib/tool-run";
import { groupMatches, parseMatches, phrasesFor } from "@/lib/auto-redact";
import { memoryKV, setKV } from "@/lib/kv";
import { SAMPLE_FEATURES, SAMPLE_TOOLS, sampleToolsInfo } from "@/sample/tools";

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }, useLocalSearchParams: () => mockParams, useFocusEffect: () => {}, Stack: { Screen: () => null } }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn(() => Promise.resolve()) }));
const mockPick = jest.fn();
jest.mock("@/lib/tools-files", () => ({
  pickFiles: (...a: unknown[]) => mockPick(...a),
  uploadJob: jest.fn(), downloadResult: jest.fn(), openFile: jest.fn(), shareFile: jest.fn(), saveToPhone: jest.fn(), readResultText: jest.fn(), asPicked: jest.fn(),
}));

const def = (op: string) => SAMPLE_TOOLS.find((t) => t.op === op) as ToolDef;
const info = sampleToolsInfo(0);
const pdf = (name: string, size = 1000) => ({ uri: `file:///${name}`, name, size, type: "application/pdf" });

describe("Tools P2 on the phone: the directory", () => {
  it("puts every tool production has on in the web's five sections, and hides what is off", () => {
    const entries = buildEntries(info);
    const keys = entries.map((e) => e.key);
    expect(sectionsOf(entries).map((s) => s.section)).toEqual(["Edit PDF", "Convert", "Secure", "Automate"]);
    for (const k of ["compress", "protect", "stamp", "scan-clean", "pdf-tables", "excel-clean", "pii-find", "share", "workflows", "templates", "rules", "organize", "form-fill", "compare"]) expect(keys).toContain(k);
    for (const k of ["esign", "merge_mail", "ask", "translate", "extract"]) expect(keys).not.toContain(k);
    // The flags decide, never the app: with e-sign and AI on, they appear.
    const more = buildEntries({ ...info, features: [...SAMPLE_FEATURES, "esign", "ask"] }).map((e) => e.key);
    expect(more).toContain("esign");
    expect(more).toContain("ask");
    // A server before Tools P2 (no features) shows only its plain catalogue.
    expect(buildEntries({ tools: SAMPLE_TOOLS.filter((t) => !t.feature), features: undefined }).some((e) => e.web && e.key !== "organize")).toBe(false);
  });

  it("runs most tools on the phone and sends the big screen ones to the web", () => {
    const entries = buildEntries(info);
    const by = (k: string) => entries.find((e) => e.key === k)!;
    expect(by("compress").tool).toBeTruthy();
    expect(by("pii-find").tool).toBeTruthy();
    expect(by("organize").web).toBe("/app/tools/pages");
    expect(by("form-fill").web).toBe("/app/tools/forms");
    expect(by("compare").web).toBe("/app/tools/compare");
    expect(by("share").web).toBe("/app/tools/share");
    expect(by("stamp").name).toBe("Stamp and number pages");
    expect(runsOnPhone(def("organize"))).toBe(false);
    expect(runsOnPhone(def("protect"))).toBe(true);
  });

  it("searches like the web: every word starts a word, names first, small words skipped", () => {
    const entries = buildEntries(info);
    expect(searchEntries(entries, "password").map((e) => e.key).slice(0, 2).sort()).toEqual(["protect", "unlock"]);
    expect(searchEntries(entries, "word").map((e) => e.key)).not.toContain("protect");
    expect(searchEntries(entries, "to excel").map((e) => e.key)).toContain("pdf-tables");
    expect(searchEntries(entries, "nepali").map((e) => e.key)).toContain("ocr");
    expect(searchEntries(entries, "")).toHaveLength(entries.length);
  });

  it("shows recent tools first, then starters, at most six", () => {
    const entries = buildEntries(info);
    expect(recentEntries(entries, []).map((e) => e.key)).toEqual(["compress", "merge", "convert", "scan-clean", "pdf-to-docx", "protect"]);
    expect(recentEntries(entries, ["stamp", "esign"]).map((e) => e.key)[0]).toBe("stamp");
    expect(entriesForFile(entries, "Scan.pdf").map((e) => e.key)).toContain("ocr");
    expect(entriesForFile(entries, "Scan.pdf").map((e) => e.key)).not.toContain("organize");
  });
});

describe("Tools P2 on the phone: runs left and words", () => {
  const limits = { runsMonthly: 100, runsDaily: 30 };
  const now = new Date("2026-10-30T12:30:00Z");

  it("shows the tighter of today's and this month's runs, with the reset in local time", () => {
    const day = runsLeft({ month: 10, day: 18 }, limits, now);
    expect(runsLeftLabel(day)).toBe("12 runs left today");
    expect(resetWhen(day, "Australia/Sydney", now)).toBe("at 11 am tomorrow");
    const month = runsLeft({ month: 99, day: 2 }, limits, now);
    expect(runsLeftLabel(month)).toBe("1 run left this month");
    expect(resetWhen(month, "Australia/Sydney", now)).toBe("on Sun 1 Nov at 11 am");
    const none = runsLeft({ month: 40, day: 30 }, limits, now);
    expect(runsLeftLabel(none)).toBe("No runs left today");
    expect(noRunsLine(none, "Australia/Sydney", now)).toBe("You have used today's 30 runs. More at 11 am tomorrow.");
    expect(resetWhen(day, "Not/AZone", now)).toBe("at 12 am tomorrow");
  });

  it("says what was saved, truncates in the middle, and waits longer each time offline", () => {
    expect(savedLine(27 * 1024, 3 * 1024)).toBe("27 KB to 3 KB, 89% smaller");
    expect(savedLine(10_000, 12_000)).toMatch(/already small/);
    expect(middleTruncate("Lease agreement 2026 final version signed.pdf", 30)).toBe("Lease agreement…ion signed.pdf");
    expect(middleTruncate("short.pdf")).toBe("short.pdf");
    expect([0, 1, 2, 3, 9].map(offlineDelay)).toEqual([2000, 4000, 8000, 15000, 15000]);
    expect(waitLine(def("ocr"), { progress: { done: 2, total: 10 } }, false)).toBe("Page 3 of 10, about 48 seconds left");
    expect(waitLine(def("compress"), {}, true)).toBe("Still working. Large files take a little longer.");
  });

  it("checks P2 options: conditional fields, minimum length, result type", () => {
    const stamp = def("stamp");
    const custom = stamp.options.find((o) => o.when);
    if (custom?.when) {
      expect(optionShown(custom, { [custom.when.option]: custom.when.is?.[0] ?? "" })).toBe(true);
      expect(optionShown(custom, { [custom.when.option]: "__other" })).toBe(!custom.when.is);
    }
    const pw = def("protect").options.find((o) => o.minLen);
    if (pw) expect(optionProblem(pw, "ab")).toMatch(/at least/);
    const pdfTo = def("pdf-to");
    if (pdfTo.extBy) expect(resultExt(pdfTo, { [pdfTo.extBy.option]: "xlsx" })).toBe("xlsx");
    expect(resultExt(def("compress"), {})).toBe("pdf");
  });
});

describe("Tools P2 on the phone: what outlives a screen", () => {
  beforeEach(() => resetToolRunCache());

  it("keeps the run in progress on the phone and forgets it after an hour", async () => {
    const store = memoryKV();
    await saveRun({ token: "t1", op: "compress", name: "a.pdf", before: 5000, at: Date.now() }, store);
    resetToolRunCache();
    expect((await loadRun(store))?.token).toBe("t1");
    await clearRun(store);
    resetToolRunCache();
    expect(await loadRun(store)).toBeNull();
    await saveRun({ token: "old", op: "compress", name: "a.pdf", at: Date.now() - 2 * 60 * 60 * 1000 }, store);
    resetToolRunCache();
    expect(await loadRun(store)).toBeNull();
  });

  it("remembers recent tools, newest first", async () => {
    const store = memoryKV();
    await rememberRecent("compress", store);
    await rememberRecent("protect", store);
    await rememberRecent("compress", store);
    resetToolRunCache();
    expect(await recentKeys(store)).toEqual(["compress", "protect"]);
  });

  it("hands a result to Compose by its token and a file to the next tool", () => {
    expect(tokenFromDownloadUrl("/api/tools/jobs/abc.def%2Bx/download")).toBe("abc.def+x");
    expect(attachToNewEmail([{ name: "a.pdf", downloadUrl: "/api/tools/jobs/tok1/download", bytes: 10 }])).toBe(true);
    expect(takePendingToolFiles()).toEqual([{ token: "tok1", name: "a.pdf", bytes: 10 }]);
    expect(takePendingToolFiles()).toEqual([]);
    expect(attachToNewEmail([{ name: "a.pdf" }])).toBe(false);
    carryFile(pdf("r.pdf"));
    expect(takeCarried()?.name).toBe("r.pdf");
    expect(takeCarried()).toBeNull();
  });

  it("reads auto redact matches, groups them and builds the phrases", () => {
    const m = parseMatches(JSON.stringify({ matches: [{ kind: "email", text: "a@b.au", page: 2 }, { kind: "tfn", text: "123 456 782", page: 1 }, { kind: "tfn", text: "123 456 782", page: 1 }, { bad: 1 }] }));
    expect(m).toHaveLength(3);
    const g = groupMatches(m);
    expect(g.map((x) => x.kind)).toEqual(["tfn", "email"]);
    expect(g[0].items).toHaveLength(1);
    expect(phrasesFor(m, new Set(["tfn|123 456 782|1"]))).toBe("123 456 782");
    expect(parseMatches("not json")).toEqual([]);
  });
});

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <QueryClientProvider client={qc}><SessionProvider initialMode="sample">{children}</SessionProvider></QueryClientProvider>
    </SafeAreaProvider>
  );
}

describe("Tools P2 screens (sample workspace)", () => {
  beforeEach(() => { mockPush.mockClear(); mockPick.mockReset(); resetToolRunCache(); setKV(memoryKV()); });

  it("runs, shows the result with every next step, and attaches it to a new email", async () => {
    mockParams = { op: "compress" };
    mockPick.mockResolvedValue([pdf("Invoice.pdf", 3_000_000)]);
    const Screen = require("@/app/tool/[op]").default;
    await render(wrap(<Screen />));
    await fireEvent.press(await screen.findByTestId("tool-add-files"));
    expect(await screen.findByText("Invoice.pdf")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("tool-run"));
    expect(await screen.findByTestId("tool-done", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByTestId("tool-saved").props.children).toMatch(/smaller/);
    expect(screen.getByTestId("tool-open")).toBeTruthy();
    expect(screen.getByTestId("tool-share")).toBeTruthy();
    expect(screen.getByTestId("tool-chain")).toBeTruthy();
    expect(screen.getByTestId("tool-start-over")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("tool-attach"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/compose", params: { tools: "1" } });
    expect(takePendingToolFiles()[0].name).toMatch(/compressed\.pdf$/);
    await fireEvent.press(screen.getByTestId("tool-start-over"));
    expect(await screen.findByTestId("tool-add-files")).toBeTruthy();
  });

  it("cancels a run: back to the start and says it was not counted", async () => {
    mockParams = { op: "compress" };
    mockPick.mockResolvedValue([pdf("Big.pdf")]);
    const Screen = require("@/app/tool/[op]").default;
    await render(wrap(<Screen />));
    await fireEvent.press(await screen.findByTestId("tool-add-files"));
    await screen.findByText("Big.pdf");
    await fireEvent.press(screen.getByTestId("tool-run"));
    await fireEvent.press(await screen.findByTestId("tool-cancel"));
    expect(await screen.findByText("Stopped. This run was not counted.")).toBeTruthy();
    expect(screen.queryByTestId("tool-done")).toBeNull();
    expect(await loadRun()).toBeNull();
  });

  it("picks a saved run back up after the app was closed", async () => {
    await saveRun({ token: "sample.compress.9", op: "compress", name: "Statement.pdf", before: 900_000, at: Date.now() });
    resetToolRunCache();
    mockParams = { op: "compress", resume: "1" };
    const Screen = require("@/app/tool/[op]").default;
    await render(wrap(<Screen />));
    expect(await screen.findByTestId("tool-done", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("blocks Run with the reset time when no runs are left", async () => {
    const { SampleTransport } = require("@/sample/transport");
    const spy = jest.spyOn(SampleTransport.prototype, "request").mockImplementation(async (...a: unknown[]) => {
      if (a[1] === "/tools") return { ...info, usage: { month: 30, day: 50 } };
      return {};
    });
    mockParams = { op: "compress" };
    const Screen = require("@/app/tool/[op]").default;
    await render(wrap(<Screen />));
    expect(await screen.findByTestId("tool-no-runs")).toBeTruthy();
    expect(screen.getByTestId("tool-no-runs").props.children).toMatch(/You have used today's 50 runs\. More at/);
    spy.mockRestore();
  });

  it("finds sensitive info, lets you untick, then blacks out the rest", async () => {
    mockParams = { op: "pii-find" };
    mockPick.mockResolvedValue([pdf("Payslip.pdf")]);
    const Screen = require("@/app/tool/[op]").default;
    await render(wrap(<Screen />));
    await fireEvent.press(await screen.findByTestId("tool-add-files"));
    await screen.findByText("Payslip.pdf");
    await fireEvent.press(screen.getByTestId("tool-run"));
    expect(await screen.findByTestId("tool-review", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByTestId("tool-burn")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("tool-burn"));
    expect(await screen.findByTestId("tool-done", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("keeps the files when the phone is offline and tries again by itself", async () => {
    const { SampleTransport } = require("@/sample/transport");
    const { ApiError } = require("@/api/errors");
    const real = SampleTransport.prototype.request;
    let failures = 1;
    const spy = jest.spyOn(SampleTransport.prototype, "request").mockImplementation(function (this: unknown, ...a: unknown[]) {
      if (a[1] === "/tools/jobs/from-attachments" && failures > 0) { failures -= 1; return Promise.reject(new ApiError(0, "network", "offline")); }
      return real.apply(this, a);
    });
    mockParams = { op: "compress" };
    mockPick.mockResolvedValue([pdf("Trip.pdf")]);
    const Screen = require("@/app/tool/[op]").default;
    await render(wrap(<Screen />));
    await fireEvent.press(await screen.findByTestId("tool-add-files"));
    await screen.findByText("Trip.pdf");
    await fireEvent.press(screen.getByTestId("tool-run"));
    expect(await screen.findByText("You're offline")).toBeTruthy();
    expect(screen.getByText("Trip.pdf")).toBeTruthy();
    expect(await screen.findByTestId("tool-done", {}, { timeout: 8000 })).toBeTruthy();
    spy.mockRestore();
  }, 15000);

  it("sends a tool that needs a big screen to the web", async () => {
    mockParams = { op: "organize" };
    const Screen = require("@/app/tool/[op]").default;
    await render(wrap(<Screen />));
    expect(await screen.findByText("Edit pages works on the web")).toBeTruthy();
  });

  it("shows Tools results in Compose and sends their tokens", async () => {
    attachToNewEmail([{ name: "Invoice-compressed.pdf", downloadUrl: "/api/tools/jobs/tokA/download", bytes: 2048 }]);
    mockParams = { tools: "1" };
    const Compose = require("@/app/compose").default;
    await render(wrap(<Compose />));
    expect(await screen.findByTestId("compose-tool-files")).toBeTruthy();
    expect(screen.getByText("Invoice-compressed.pdf")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("2 KB")).toBeTruthy());
  });
});
