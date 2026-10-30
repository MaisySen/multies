import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "@/lib/session";
import {
  concatBytes, defaultsFor, filesProblem, groupTools, multipartParts, optionProblem, pickerTypes, resultLine, toolsForFile, toolTakes, uploadQuery, usageLine,
  type ToolDef,
} from "@/lib/tools";
import { SAMPLE_TOOLS, sampleToolsInfo } from "@/sample/tools";
import { COMMANDS, createHandlers } from "@/lib/commands";
import { resetToolRunCache } from "@/lib/tool-run";
import { memoryKV, setKV } from "@/lib/kv";

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }, useLocalSearchParams: () => mockParams, useFocusEffect: () => {}, Stack: { Screen: () => null } }));
const mockOpenBrowser = jest.fn(() => Promise.resolve());
jest.mock("expo-web-browser", () => ({ openBrowserAsync: (...a: unknown[]) => mockOpenBrowser(...(a as [])) }));
const mockPick = jest.fn();
jest.mock("@/lib/tools-files", () => ({
  pickFiles: (...a: unknown[]) => mockPick(...a),
  uploadJob: jest.fn(), downloadResult: jest.fn(), openFile: jest.fn(), shareFile: jest.fn(), saveToPhone: jest.fn(), readResultText: jest.fn(), asPicked: jest.fn(),
}));

const def = (op: string) => SAMPLE_TOOLS.find((t) => t.op === op) as ToolDef;
const limits = sampleToolsInfo(0).limits;
const pdf = (name: string, size = 1000) => ({ uri: `file:///${name}`, name, size, type: "application/pdf" });

describe("Tools on the phone: the rules", () => {
  it("groups the P1 tools by their catalogue group (older servers)", () => {
    const p1 = SAMPLE_TOOLS.filter((t) => !t.feature && !t.path);
    const g = groupTools(p1);
    expect(g.map((x) => x.group)).toEqual(["Organise", "Convert", "Protect", "Scans"]);
    expect(g.reduce((n, x) => n + x.tools.length, 0)).toBe(13);
  });

  it("offers a mail attachment only the phone tools that take it, never merge or the web editors", () => {
    const forPdf = toolsForFile(SAMPLE_TOOLS, "Invoice.PDF").map((t) => t.op);
    expect(forPdf).toContain("compress");
    expect(forPdf).toContain("redact");
    expect(forPdf).toContain("protect");
    expect(forPdf).toContain("pii-find");
    expect(forPdf).not.toContain("merge");
    expect(forPdf).not.toContain("organize");
    expect(forPdf).not.toContain("compare");
    expect(forPdf).not.toContain("convert");
    expect(toolsForFile(SAMPLE_TOOLS, "Quote.docx").map((t) => t.op)).toEqual(["convert"]);
    expect(toolsForFile(SAMPLE_TOOLS, "backup.zip")).toEqual([]);
    expect(toolTakes(def("images-to-pdf"), "IMG_0001", "image/jpeg")).toBe(true);
  });

  it("checks files on the phone before anything is sent", () => {
    expect(filesProblem(def("merge"), [pdf("a.pdf")], limits)).toBe("Add at least 2 files.");
    expect(filesProblem(def("merge"), [pdf("a.pdf"), pdf("b.pdf")], limits)).toBeNull();
    expect(filesProblem(def("compress"), [], limits)).toBe("Add a file first.");
    expect(filesProblem(def("compress"), [pdf("a.docx")], limits)).toMatch(/takes a PDF, not a\.docx/);
    expect(filesProblem(def("compress"), [pdf("big.pdf", 30 * 1024 * 1024)], limits)).toMatch(/up to 25 MB/);
    expect(filesProblem(def("protect"), [pdf("a.pdf")], limits)).toBeNull();
    expect(filesProblem(def("ocr"), [pdf("scan.pdf", 21 * 1024 * 1024)], limits)).toMatch(/up to 20 MB/);
  });

  it("validates options with the web page's words", () => {
    const split = def("split").options[0];
    expect(optionProblem(split, "")).toBe("Pages for each part is needed.");
    expect(optionProblem(split, "1-3, 5")).toBeNull();
    expect(optionProblem(split, "first page")).toBe("Use page numbers and ranges, like 1-3, 5.");
    const opacity = def("watermark").options[1];
    expect(optionProblem(opacity, "90")).toBe("Strength (percent) goes from 10 to 60.");
    expect(defaultsFor(def("rotate"))).toEqual({ angle: "90", ranges: "" });
  });

  it("builds the same form upload the web page sends", () => {
    const body = concatBytes(multipartParts("B", { ranges: "1-2", empty: " " }, [{ name: "a\"b.pdf", type: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) }]));
    const text = Buffer.from(body).toString("latin1");
    expect(text).toContain('Content-Disposition: form-data; name="ranges"\r\n\r\n1-2\r\n');
    expect(text).not.toContain('name="empty"');
    expect(text).toContain('name="files"; filename="a_b.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF\r\n');
    expect(text.endsWith("--B--\r\n")).toBe(true);
    expect(uploadQuery("merge", [pdf("Q3 report.pdf"), pdf("b.pdf")])).toBe("op=merge&files=2&name=Q3%20report.pdf");
    // Tools P2: the option the result type follows rides in the query (the server streams the form unread).
    expect(uploadQuery("pdf-to", [pdf("a.pdf")], { name: "format", value: "xlsx" })).toBe("op=pdf-to&files=1&name=a.pdf&format=xlsx");
  });

  it("asks the picker for the right file types and says when the plan's runs are used", () => {
    expect(pickerTypes(def("convert"))).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(pickerTypes(def("compress"))).toEqual(["application/pdf"]);
    expect(usageLine({ usage: { month: 200, day: 3 }, limits }).blocked).toBe(true);
    expect(usageLine({ usage: { month: 2, day: 2 }, limits }).text).toBe("2 of 200 runs used this month. Files up to 25 MB.");
    expect(resultLine({ token: "t", op: "compress", status: "done", name: "a.pdf", bytes: 2048, result: { pages: 3 } })).toBe("3 pages, 2 KB");
  });

  it("has a Tools command that opens the Tools screen", () => {
    expect(COMMANDS.find((c) => c.id === "tools")?.title).toBe("Tools");
    const navigate = jest.fn();
    createHandlers({ navigate, openWeb: jest.fn() }).tools({});
    expect(navigate).toHaveBeenCalledWith("/tools");
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

describe("Tools screens (sample workspace)", () => {
  beforeEach(() => { mockPush.mockClear(); mockPick.mockReset(); resetToolRunCache(); setKV(memoryKV()); });

  it("lists the tools in five sections with the runs left line, and opens a tool's screen", async () => {
    const Tools = require("@/app/tools").default;
    await render(wrap(<Tools />));
    expect(await screen.findByTestId("tool-compress")).toBeTruthy();
    expect(screen.getByTestId("tools-group-Edit PDF")).toBeTruthy();
    expect(screen.getByTestId("tools-group-Convert")).toBeTruthy();
    expect(screen.getByTestId("tools-group-Secure")).toBeTruthy();
    expect(screen.getByTestId("tools-group-Automate")).toBeTruthy();
    expect(screen.queryByTestId("tools-group-Smart")).toBeNull();
    expect(screen.getByText("Make searchable")).toBeTruthy();
    expect(screen.getByTestId("tools-usage").props.children).toMatch(/runs left today/);
    expect(screen.getByTestId("tools-recent")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("tool-merge"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/tool/[op]", params: { op: "merge" } });
  });

  it("finds tools by search and opens web only tools in the browser", async () => {
    const Tools = require("@/app/tools").default;
    await render(wrap(<Tools />));
    await fireEvent.changeText(await screen.findByTestId("tools-search"), "password");
    expect(await screen.findByTestId("tools-results")).toBeTruthy();
    expect(screen.getByTestId("tool-protect")).toBeTruthy();
    expect(screen.getByTestId("tool-unlock")).toBeTruthy();
    expect(screen.queryByTestId("tool-compress")).toBeNull();
    await fireEvent.changeText(screen.getByTestId("tools-search"), "edit pages");
    await fireEvent.press(await screen.findByTestId("tool-organize"));
    expect(mockOpenBrowser).toHaveBeenCalled();
    expect(String((mockOpenBrowser.mock.calls[0] as unknown[])[0])).toMatch(/\/app\/tools\/pages$/);
    await fireEvent.changeText(screen.getByTestId("tools-search"), "zzzz");
    expect(await screen.findByTestId("tools-no-results")).toBeTruthy();
  });

  it("runs a tool: pick a file, run, see the result with Open and Share", async () => {
    mockParams = { op: "compress" };
    mockPick.mockResolvedValue([pdf("Invoice.pdf", 420_000)]);
    const Sheet = require("@/app/tool/[op]").default;
    await render(wrap(<Sheet />));
    await fireEvent.press(await screen.findByTestId("tool-run"));
    expect(await screen.findByText("Add a file first.")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("tool-add-files"));
    expect(await screen.findByText("Invoice.pdf")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("tool-run"));
    expect(await screen.findByTestId("tool-done", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByTestId("tool-open")).toBeTruthy();
    expect(screen.getByText("Quarterly report-compressed.pdf")).toBeTruthy();
  });

  it("shows option fields and blocks a run until a required one is filled", async () => {
    mockParams = { op: "watermark" };
    mockPick.mockResolvedValue([pdf("Draft.pdf")]);
    const Sheet = require("@/app/tool/[op]").default;
    await render(wrap(<Sheet />));
    await fireEvent.press(await screen.findByTestId("tool-add-files"));
    await screen.findByText("Draft.pdf");
    await fireEvent.press(screen.getByTestId("tool-run"));
    expect(await screen.findByText("Watermark text is needed.")).toBeTruthy();
    expect(screen.queryByTestId("tool-progress")).toBeNull();
  });

  it("opens straight on a mail attachment with no file picking", async () => {
    mockParams = { op: "compress", attachment: "att_1", name: "Statement.pdf" };
    const Sheet = require("@/app/tool/[op]").default;
    await render(wrap(<Sheet />));
    expect(await screen.findByText("From your email")).toBeTruthy();
    expect(screen.getByText("Statement.pdf")).toBeTruthy();
    expect(screen.queryByTestId("tool-add-files")).toBeNull();
  });

  it("gives a PDF attachment a short Tools sheet, most useful first, then More tools", async () => {
    const { AttachmentRow } = require("@/components/attachment-tools");
    await render(wrap(<AttachmentRow a={{ id: "att_9", filename: "Contract.pdf", contentType: "application/pdf", sizeBytes: 90_000, available: true }} />));
    await fireEvent.press(await screen.findByText("Tools"));
    expect(await screen.findByTestId("sheet-compress")).toBeTruthy();
    expect(screen.getByTestId("sheet-pdf-to-docx")).toBeTruthy();
    expect(screen.queryByTestId("sheet-merge")).toBeNull();
    expect(screen.queryByTestId("sheet-redact")).toBeNull();
    await fireEvent.press(screen.getByTestId("sheet-__more"));
    await fireEvent.press(await screen.findByTestId("sheet-redact"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/tool/[op]", params: { op: "redact", attachment: "att_9", name: "Contract.pdf" } });
  });

  it("shows a file no tool takes without a Tools button", async () => {
    const { AttachmentRow } = require("@/components/attachment-tools");
    await render(wrap(<AttachmentRow a={{ id: "att_8", filename: "backup.zip", contentType: "application/zip", sizeBytes: 900, available: true }} />));
    expect(await screen.findByText("backup.zip")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Tools")).toBeNull());
  });
});
