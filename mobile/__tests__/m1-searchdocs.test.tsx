/**
 * M1: global Search and Docs (reader, comments, share links) on the phone. Mock only: every request goes to the sample
 * transport, nothing reaches a server.
 */
import { Alert } from "react-native";
import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { sampleDocs } from "@/sample/docs";
import { ApiError } from "@/api/errors";
import { setOffline } from "@/lib/offline";
import { COMMANDS, createHandlers } from "@/lib/commands";
import {
  LIMIT_ALL, LIMIT_ONE, SEARCH_MAX_CHARS, cleanQuery, correctedLine, countsByChoice, phoneTarget, searchPath, serverTypes, visibleChoices,
} from "@/lib/global-search";
import {
  commentProblem, docBlocks, imageSource, imageSrcOk, linkLine, moderation, noAccess, spansOf, treeRows, untitled, whiteboardWords, type CommentView, type TreeNode,
} from "@/lib/docs";
import Search from "@/app/search";
import Docs from "@/app/docs";
import DocReader from "@/app/doc/[id]";
import DocComments from "@/app/doc/comments/[id]";
import DocShare from "@/app/doc/share/[id]";

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
}));
const mockCopy = jest.fn(async (_s: string) => true);
jest.mock("expo-clipboard", () => ({ setStringAsync: (s: string) => mockCopy(s) }));
const mockOpen = jest.fn(async (_u: string) => ({ type: "dismiss" }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: (u: string) => mockOpen(u), openAuthSessionAsync: jest.fn(), maybeCompleteAuthSession: jest.fn() }));

configure({ asyncUtilTimeout: 10_000 });
jest.setTimeout(60_000);

/* ---------------------------------------------------------------- search rules */

describe("global search rules (the web's)", () => {
  it("cleans a query like the server: spaces collapsed, trimmed, the first 100 characters", () => {
    expect(cleanQuery("  quarter   plan \n")).toBe("quarter plan");
    const long = "word ".repeat(80);
    expect(cleanQuery(long).length).toBeLessThanOrEqual(SEARCH_MAX_CHARS);
    expect(cleanQuery("a".repeat(69))).toHaveLength(69);
  });
  it("asks for the right types and limits", () => {
    expect(searchPath("plan", "all")).toBe(`/search?q=plan&limit=${LIMIT_ALL}`);
    expect(searchPath("a b", "contacts")).toBe(`/search?q=a%20b&types=contacts,deals&limit=${LIMIT_ONE}`);
    expect(serverTypes("mail")).toEqual(["mail", "attachments"]);
    expect(serverTypes("docs")).toEqual(["docs"]);
  });
  it("shows only the chips the server answered, plus All and the picked one", () => {
    expect(visibleChoices(["docs", "deals"], "all").map((c) => c.id)).toEqual(["all", "docs", "contacts"]);
    expect(visibleChoices([], "files").map((c) => c.id)).toEqual(["all", "files"]);
    expect(countsByChoice([{ type: "contacts", label: "Contacts", items: [{} as never] }, { type: "deals", label: "Deals", items: [{} as never, {} as never] }])).toEqual({ contacts: 3 });
  });
  it("opens each kind on its phone screen, and the web for the rest", () => {
    expect(phoneTarget({ type: "mail", id: "x", url: "/app/mail?mailbox=mb1&folder=inbox&m=msg_1" })).toEqual({ kind: "screen", pathname: "/thread/[id]", params: { id: "msg_1" } });
    expect(phoneTarget({ type: "tasks", id: "x", url: "/app/tasks?project=p1&task=tsk_9" })).toEqual({ kind: "screen", pathname: "/task/[id]", params: { id: "tsk_9" } });
    expect(phoneTarget({ type: "docs", id: "x", url: "/app/docs/doc_plan" })).toEqual({ kind: "screen", pathname: "/doc/[id]", params: { id: "doc_plan" } });
    expect(phoneTarget({ type: "chat", id: "x", url: "/app/chat/ch_1?thread=m2" })).toEqual({ kind: "screen", pathname: "/chat/[id]", params: { id: "ch_1" } });
    expect(phoneTarget({ type: "contacts", id: "x", url: "/app/contacts/con_1" })).toEqual({ kind: "screen", pathname: "/contact/[id]", params: { id: "con_1" } });
    expect(phoneTarget({ type: "deals", id: "x", url: "/app/deals?deal=d1" })).toEqual({ kind: "web", path: "/app/deals?deal=d1" });
    expect(phoneTarget({ type: "files", id: "x", url: "/app/tasks?project=p&task=t1" })).toMatchObject({ pathname: "/task/[id]" });
    expect(phoneTarget({ type: "notes", id: "x", url: "https://elsewhere.example" }).kind).toBe("web");
  });
  it("says when it fixed a typo", () => {
    expect(correctedLine({ query: "qaurter", corrected: "quarter" })).toBe('Showing results for "quarter"');
    expect(correctedLine({ query: "plan" })).toBeNull();
  });
});

/* ---------------------------------------------------------------- docs rules */

const node = (id: string, title: string, children: TreeNode[] = [], position = 1): TreeNode => ({ id, title, parentId: null, position, projectId: null, updatedAt: "2026-11-01T00:00:00Z", depth: 1, children });

describe("docs tree", () => {
  const tree = [node("a", "Handbook", [node("a1", "Leave policy"), node("a2", "Expenses", [], 2)]), node("b", "", [], 2)];
  it("shows top pages, unfolds on request, and names untitled pages", () => {
    expect(treeRows(tree).map((r) => r.title)).toEqual(["Handbook", "Untitled"]);
    expect(treeRows(tree, { open: new Set(["a"]) }).map((r) => `${r.depth}:${r.title}`)).toEqual(["0:Handbook", "1:Leave policy", "1:Expenses", "0:Untitled"]);
    expect(untitled("  ")).toBe("Untitled");
  });
  it("search keeps matches with the pages above them", () => {
    const rows = treeRows(tree, { query: "leave" });
    expect(rows.map((r) => r.title)).toEqual(["Handbook", "Leave policy"]);
    expect(rows[1].path).toEqual(["Handbook"]);
  });
});

describe("doc content (the editor's JSON)", () => {
  const plan = sampleDocs(Date.now()).docs[0].content;
  it("turns every block into a native block, without the trailing empty paragraph", () => {
    const kinds = docBlocks(plan).map((b) => b.t);
    expect(kinds).toEqual(["heading", "paragraph", "list", "list", "heading", "tasks", "quote", "callout", "table", "code", "web", "rule", "paragraph"]);
  });
  it("keeps marks and links", () => {
    const spans = spansOf([{ type: "text", text: "Hi", marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://multies.si" } }] }, { type: "hardBreak" }, { type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }]);
    expect(spans[0]).toMatchObject({ text: "Hi", bold: true, href: "https://multies.si" });
    expect(spans[1].text).toBe("\n");
    expect(spans[2].href).toBeUndefined();
  });
  it("reads tables, checklists, whiteboards and diagrams", () => {
    const blocks = docBlocks(plan);
    const table = blocks.find((b) => b.t === "table");
    expect(table && table.t === "table" && table.rows[0]).toMatchObject({ header: true });
    const tasks = blocks.find((b) => b.t === "tasks");
    expect(tasks && tasks.t === "tasks" && tasks.items.map((i) => i.checked)).toEqual([true, false, false]);
    expect(whiteboardWords(JSON.stringify([{ type: "text", text: "Floor plan" }, { type: "rect" }, { type: "text", text: "gone", isDeleted: true }]))).toEqual(["Floor plan"]);
    expect(whiteboardWords("not json")).toEqual([]);
    expect(docBlocks({ type: "doc", content: [{ type: "diagram", content: [{ type: "text", text: "graph" }] }] })[0]).toMatchObject({ t: "web", what: "Diagram" });
    expect(docBlocks({ type: "doc", content: [{ type: "embed" }] })[0]).toMatchObject({ t: "web" });
  });
  it("loads images with the session only from the workspace's own server", () => {
    const h = () => ({ cookie: "s=1" });
    expect(imageSrcOk("/api/doc-images/img_1")).toBe(true);
    expect(imageSrcOk("http://plain.example/a.png")).toBe(false);
    expect(imageSource("/api/doc-images/img_1", "https://multies.si", h)).toEqual({ uri: "https://multies.si/api/doc-images/img_1", headers: { cookie: "s=1" } });
    expect(imageSource("https://cdn.example/a.png", "https://multies.si", h)).toEqual({ uri: "https://cdn.example/a.png" });
  });
});

describe("comments and share rules", () => {
  const c = (over: Partial<CommentView>): CommentView => ({ id: "c", thread: "team", body: "x", status: "visible", author: { type: "member", name: "A" }, createdAt: "2026-11-01T00:00:00Z", editedAt: null, mine: false, canEdit: false, canRemove: false, ...over });
  it("checks the body like the server", () => {
    expect(commentProblem("  ")).toBe("Write a comment first.");
    expect(commentProblem("a".repeat(4001))).toMatch(/^Keep it under 4,000 characters/);
    expect(commentProblem("ok")).toBeNull();
  });
  it("offers Show or Hide only to moderators, only on public comments", () => {
    expect(moderation(c({ thread: "public" }), true)).toEqual({ label: "Hide", status: "hidden" });
    expect(moderation(c({ thread: "public", status: "hidden" }), true)).toEqual({ label: "Show", status: "visible" });
    expect(moderation(c({ thread: "public" }), false)).toBeNull();
    expect(moderation(c({ thread: "team" }), true)).toBeNull();
  });
  it("words a link's dates and reads no access errors", () => {
    expect(linkLine({ createdAt: "2026-11-01T00:00:00Z", expiresAt: null })).toMatch(/works until turned off$/);
    expect(noAccess(new ApiError(403, "forbidden", "x"))).toBe(true);
    expect(noAccess(new ApiError(500, "error", "x"))).toBe(false);
  });
  it("has a Docs command and Search keeps its name short", () => {
    expect(COMMANDS.find((x) => x.id === "docs")?.title).toBe("Docs");
    const navigate = jest.fn();
    (createHandlers({ navigate } as never) as Record<string, () => void>).docs!();
    expect(navigate).toHaveBeenCalledWith("/docs");
  });
  it("has no dashes in the new words", () => {
    expect(JSON.stringify([linkLine({ createdAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-08T00:00:00Z" }), commentProblem(""), correctedLine({ query: "a", corrected: "b" })])).not.toMatch(/[\u2013\u2014]/);
  });
});

/* ---------------------------------------------------------------- screens, on the sample workspace */

async function wrap(ui: ReactNode, transport = new SampleTransport(), seed?: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  seed?.(qc);
  const view = await render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
  return { qc, transport, view };
}

describe("Search screen", () => {
  beforeEach(() => { mockPush.mockClear(); setOffline(false); });

  it("searches everything, groups results with counts and chips, and opens a doc", async () => {
    await wrap(<Search />);
    await fireEvent.changeText(await screen.findByTestId("search"), "quarter plan");
    await screen.findByTestId("search-docs-doc_plan", undefined, { timeout: 10_000 });
    expect(screen.getByTestId("search-chip-all")).toBeTruthy();
    expect(screen.getByTestId("search-chip-docs")).toBeTruthy();
    expect(screen.queryByTestId("search-chip-chat")).toBeNull();
    await fireEvent.press(screen.getByTestId("search-docs-doc_plan"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/doc/[id]", params: { id: "doc_plan" } });
  });

  it("narrows to one type with a chip (Contacts brings deals too)", async () => {
    const t = new SampleTransport();
    const spy = jest.spyOn(t, "request");
    await wrap(<Search />, t);
    await fireEvent.changeText(await screen.findByTestId("search"), "harbour");
    await screen.findByTestId("search-chip-contacts");
    await fireEvent.press(screen.getByTestId("search-chip-contacts"));
    await screen.findByTestId("search-deals-deal_1");
    expect(spy.mock.calls.some((c) => String(c[1]).includes("types=contacts,deals&limit=20"))).toBe(true);
  });

  it("sends a long query trimmed to what the server reads", async () => {
    const t = new SampleTransport();
    const spy = jest.spyOn(t, "request");
    await wrap(<Search />, t);
    await fireEvent.changeText(await screen.findByTestId("search"), `quarter ${"x".repeat(300)}`);
    await screen.findByText(/^No matches$/);
    const call = spy.mock.calls.find((c) => String(c[1]).startsWith("/search?"));
    const q = decodeURIComponent(String(call?.[1]).split("q=")[1].split("&")[0]);
    expect(q.length).toBeLessThanOrEqual(100);
  });

  it("shows a plain retry when search fails, and searches mail the old way on a server without global search", async () => {
    const t = new SampleTransport();
    const real = t.request.bind(t);
    let mode: "fail" | "old" = "fail";
    jest.spyOn(t, "request").mockImplementation(async (m, p, b, o) => {
      if (String(p).startsWith("/search?")) throw mode === "fail" ? new ApiError(500, "error", "boom") : new ApiError(404, "not_found", "Page not found.");
      return real(m, p, b, o);
    });
    const { view } = await wrap(<Search />, t);
    await fireEvent.changeText(await screen.findByTestId("search"), "plan");
    await screen.findByTestId("search-retry");
    expect(screen.getByText("Search didn't answer. Try again.")).toBeTruthy();
    view.unmount();
    mode = "old";
    await wrap(<Search />, t);
    await fireEvent.changeText(await screen.findByTestId("search"), "zzzz");
    await screen.findByText(/^No matches$/);
  });
});

describe("Docs screens", () => {
  beforeEach(() => { mockPush.mockClear(); mockOpen.mockClear(); setOffline(false); });

  it("lists the tree, unfolds a page and searches titles", async () => {
    await wrap(<Docs />);
    await screen.findByTestId("doc-row-doc_plan");
    expect(screen.getByText("Untitled")).toBeTruthy();
    expect(screen.queryByTestId("doc-row-doc_board")).toBeNull();
    await fireEvent.press(screen.getByTestId("doc-toggle-doc_plan"));
    await screen.findByTestId("doc-row-doc_board");
    await fireEvent.changeText(screen.getByTestId("docs-search"), "weekly");
    await screen.findByTestId("doc-row-doc_sync");
    expect(screen.queryByTestId("doc-row-doc_plan")).toBeNull();
    await fireEvent.press(screen.getByTestId("doc-row-doc_sync"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/doc/[id]", params: { id: "doc_sync" } });
  });

  it("shows a plain no access state when the server refuses", async () => {
    const t = new SampleTransport();
    const real = t.request.bind(t);
    jest.spyOn(t, "request").mockImplementation(async (m, p, b, o) => { if (p === "/docs/tree") throw new ApiError(403, "forbidden", "Forbidden"); return real(m, p, b, o); });
    await wrap(<Docs />, t);
    await screen.findByText("No access to Docs");
  });

  it("reads a doc natively, with comments, share and Open on the web", async () => {
    mockParams = { id: "doc_plan" };
    await wrap(<DocReader />);
    await screen.findByText("Quarter plan");
    expect(screen.getByText("Goals for this quarter")).toBeTruthy();
    expect(screen.getByText("Priya")).toBeTruthy(); // a table cell
    expect(screen.getByText("Office hours: 8:30 to 5:30\nSupport line: 1300 000 000")).toBeTruthy();
    expect(screen.getByText("Open on the web to see this.")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("doc-comments").props.accessibilityLabel).toBe("Comments, 2"));
    await fireEvent.press(screen.getByTestId("doc-web"));
    expect(mockOpen).toHaveBeenCalledWith(expect.stringMatching(/\/app\/docs\/doc_plan$/));
  });

  it("hides comments when Docs plus is off for the workspace", async () => {
    mockParams = { id: "doc_plan" };
    await wrap(<DocReader />, new SampleTransport(), (qc) => qc.setQueryData(["web-config", "sample"], { docsPlus: false }));
    await screen.findByText("Quarter plan");
    expect(screen.queryByTestId("doc-comments")).toBeNull();
    expect(screen.getByTestId("doc-share")).toBeTruthy();
  });

  it("says when a doc is gone", async () => {
    mockParams = { id: "doc_nope" };
    await wrap(<DocReader />);
    await screen.findByText("Can't open this doc");
  });

  it("adds, edits and deletes your own comment", async () => {
    mockParams = { id: "doc_plan" };
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { buttons?.find((x) => x.style === "destructive")?.onPress?.(); });
    await wrap(<DocComments />);
    await screen.findByText("Can we move the office date to April?");
    expect(screen.queryByTestId("comment-edit-cmt_1")).toBeNull(); // not mine
    await fireEvent.press(screen.getByTestId("comment-send"));
    expect(screen.queryByTestId("comment-problem")).toBeNull(); // disabled while empty
    await fireEvent.changeText(screen.getByTestId("comment-input"), "Booked the movers");
    await fireEvent.press(screen.getByTestId("comment-send"));
    await screen.findByText("Booked the movers");
    await fireEvent.press(screen.getByTestId("comment-edit-cmt_2"));
    await fireEvent.changeText(screen.getByTestId("comment-edit-input"), "March works, lease signed.");
    await fireEvent.press(screen.getByTestId("comment-save"));
    await screen.findByText("March works, lease signed.");
    await fireEvent.press(screen.getByTestId("comment-delete-cmt_2"));
    await waitFor(() => expect(screen.queryByText("March works, lease signed.")).toBeNull());
    alert.mockRestore();
  });

  it("makes a read only link, copies it and turns it off", async () => {
    mockParams = { id: "doc_plan" };
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { buttons?.find((x) => x.style === "destructive")?.onPress?.(); });
    await wrap(<DocShare />);
    await screen.findByText("No active links.");
    await fireEvent.press(screen.getByTestId("share-create"));
    await screen.findByTestId("share-fresh");
    await fireEvent.press(screen.getByTestId("share-copy"));
    await waitFor(() => expect(mockCopy).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/multies\.si\/s\//)));
    const row = await screen.findByText(/works until turned off/);
    expect(row).toBeTruthy();
    const revoke = screen.getAllByTestId(/^share-revoke-/)[0];
    await fireEvent.press(revoke);
    await screen.findByText("No active links.");
    expect(screen.queryByTestId("share-fresh")).toBeNull();
    alert.mockRestore();
  });

  it("says when an admin turned share links off", async () => {
    mockParams = { id: "doc_plan" };
    const t = new SampleTransport();
    const real = t.request.bind(t);
    jest.spyOn(t, "request").mockImplementation(async (m, p, b, o) => (String(p).startsWith("/share-links?") ? ({ links: [], allowShareLinks: false } as never) : real(m, p, b, o)));
    await wrap(<DocShare />, t);
    await screen.findByTestId("share-off");
    expect(screen.queryByTestId("share-create")).toBeNull();
  });
});
