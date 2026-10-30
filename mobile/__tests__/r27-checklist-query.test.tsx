/**
 * R27: checklists inside a task and the task query box on the Tasks tab, against the sample
 * workspace (which answers the same routes and shapes as the server's R26 checklist and query API).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Alert } from "react-native";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { filterByQuery } from "@/sample/checklists";
import { ApiError, toApiError } from "@/api/errors";
import { applyOrder, cleanItemTitle, draftItem, moveIds, patchItem, progressBadge, progressFraction, progressLabel, removeItem, summarise } from "@/lib/checklist";
import { LAST_QUERY_KEY, hasTerm, loadLastQuery, normaliseQuery, queryErrorText, queryTerms, saveLastQuery, toggleTerm } from "@/lib/task-query";
import { kv, memoryKV, setKV } from "@/lib/kv";
import type { ChecklistItem, Task } from "@/api/types";
import type { Method, RequestOptions } from "@/api/transport";

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

/** The sample workspace, with a switch that makes checklist writes fail like a server error. */
class FlakyTransport extends SampleTransport {
  failChecklistWrites = false;
  calls: string[] = [];
  async request<T>(method: Method, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    this.calls.push(`${method} ${path}`);
    if (this.failChecklistWrites && method !== "GET" && path.includes("checklist")) throw new ApiError(500, "error", "The server had a problem.");
    return super.request<T>(method, path, body, opts);
  }
}

let transport: FlakyTransport;
async function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}
const bas = async () => (await transport.request<{ tasks: Task[] }>("GET", "/tasks")).tasks.find((t) => t.title.startsWith("Lodge the September"))!;

beforeEach(() => { transport = new FlakyTransport(); mockPush.mockClear(); mockParams = {}; setKV(memoryKV()); });

const item = (id: string, position: number, done = false): ChecklistItem => ({ id, taskId: "tsk_1", title: id, done, position, assignee: null, due: null, createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z" });

describe("checklist helpers", () => {
  it("labels progress in plain words and as a badge", () => {
    expect(progressLabel({ total: 5, done: 3 })).toBe("3 of 5 done");
    expect(progressLabel({ total: 0, done: 0 })).toBeNull();
    expect(progressLabel(undefined)).toBeNull();
    expect(progressBadge({ total: 5, done: 3 })).toBe("3/5");
    expect(progressBadge({ total: 0, done: 0 })).toBeNull();
    expect(progressFraction({ total: 4, done: 1 })).toBe(0.25);
    expect(progressFraction({ total: 0, done: 0 })).toBe(0);
  });
  it("changes, removes, drafts and reorders items without touching the others", () => {
    const list = [item("a", 1), item("b", 2, true), item("c", 3)];
    expect(summarise(list)).toEqual({ total: 3, done: 1 });
    expect(patchItem(list, "a", { done: true }).map((i) => i.done)).toEqual([true, true, false]);
    expect(removeItem(list, "b").map((i) => i.id)).toEqual(["a", "c"]);
    const d = draftItem("tsk_1", "New", list, "2026-10-26T01:00:00Z");
    expect(d.position).toBe(4);
    expect(d.id.startsWith("chk_draft_")).toBe(true);
    expect(moveIds(list, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveIds(list, "c", 1)).toBeNull();
    expect(moveIds(list, "a", -1)).toBeNull();
    expect(applyOrder(list, ["c", "a", "b"]).map((i) => `${i.id}${i.position}`)).toEqual(["c1", "a2", "b3"]);
    expect(cleanItemTitle("  two   words \n")).toBe("two words");
    expect(cleanItemTitle("x".repeat(600))).toHaveLength(500);
  });
});

describe("task query helpers", () => {
  it("splits, toggles and tidies queries, keeping quoted words together", () => {
    expect(queryTerms('label:bug "free text" -label:wontfix')).toEqual(["label:bug", '"free text"', "-label:wontfix"]);
    expect(toggleTerm("label:bug", "assignee:me")).toBe("label:bug assignee:me");
    expect(toggleTerm("label:bug assignee:me", "assignee:me")).toBe("label:bug");
    expect(hasTerm("Label:Bug due:<7d", "label:bug")).toBe(true);
    expect(normaliseQuery("  a   b ")).toBe("a b");
    expect(normaliseQuery("x".repeat(600))).toHaveLength(500);
  });
  it("reads the server's bad_query position and names the part that went wrong", () => {
    const err = toApiError(400, { error: { code: "bad_query", message: "Unknown key \"foo\".", details: { position: 11 } } });
    expect(err.code).toBe("bad_query");
    expect(err.details.position).toBe(11);
    expect(queryErrorText(err, "label:bug foo:bar")).toBe('Unknown key "foo". Check "foo:bar" (character 11).');
    expect(queryErrorText(toApiError(400, { error: { code: "bad_query", message: "Bad query." } }), "x")).toBe("Bad query.");
    expect(queryErrorText(new ApiError(0, "network", "offline"), "x")).toBeNull();
    expect(queryErrorText(new Error("x"), "x")).toBeNull();
  });
  it("remembers the last query on this phone, and forgets it when cleared", async () => {
    const store = memoryKV();
    await saveLastQuery(store, "  label:bug  ");
    expect(await store.get(LAST_QUERY_KEY)).toBe("label:bug");
    expect(await loadLastQuery(store)).toBe("label:bug");
    await saveLastQuery(store, "");
    expect(await loadLastQuery(store)).toBe("");
  });
});

describe("sample workspace answers like the server", () => {
  it("filters with the query language and refuses an unknown key with its position", async () => {
    const { tasks } = await transport.request<{ tasks: Task[] }>("GET", `/tasks?q=${encodeURIComponent("label:tax assignee:me")}`);
    expect(tasks.map((t) => t.title)).toEqual(["Lodge the September quarter BAS"]);
    const all = (await transport.request<{ tasks: Task[] }>("GET", "/tasks")).tasks;
    expect(filterByQuery(all, "has:checklist").map((t) => t.title)).toEqual(["Lodge the September quarter BAS"]);
    expect(filterByQuery(all, "-status:done").every((t) => t.status !== "done")).toBe(true);
    expect(filterByQuery(all, '"stall signage"').length).toBe(1);
    expect(() => filterByQuery(all, "label:bug foo:bar")).toThrow(expect.objectContaining({ status: 400, code: "bad_query", details: { position: 11 } }));
  });
  it("lists, adds, ticks, renames, reorders and deletes checklist items, and task rows carry the count", async () => {
    const t = await bas();
    expect(t.checklist).toEqual({ total: 5, done: 2 });
    const v = await transport.request<{ items: ChecklistItem[]; total: number; done: number }>("GET", `/tasks/${t.ref}/checklist`);
    expect([v.total, v.done]).toEqual([5, 2]);
    const { items: [made] } = await transport.request<{ items: ChecklistItem[] }>("POST", `/tasks/${t.id}/checklist`, { title: "Tell Josh" });
    await transport.request("PATCH", `/checklist-items/${made.id}`, { done: true, title: "Tell Josh it's done" });
    await transport.request("POST", `/tasks/${t.id}/checklist/reorder`, { ids: [made.id, ...v.items.map((i) => i.id)] });
    let after = await transport.request<{ items: ChecklistItem[]; done: number }>("GET", `/tasks/${t.id}/checklist`);
    expect(after.items[0]).toMatchObject({ title: "Tell Josh it's done", done: true, position: 1 });
    expect((await bas()).checklist).toEqual({ total: 6, done: 3 });
    await transport.request("DELETE", `/checklist-items/${made.id}`);
    after = await transport.request("GET", `/tasks/${t.id}/checklist`);
    expect(after.items).toHaveLength(5);
    await expect(transport.request("POST", `/tasks/${t.id}/checklist`, { title: " " })).rejects.toMatchObject({ status: 400 });
  });
});

describe("task detail checklist", () => {
  it("shows progress and ticks an item at once", async () => {
    const t = await bas();
    mockParams = { id: t.id };
    const Detail = require("@/app/task/[id]").default;
    await wrap(<Detail />);
    expect(await screen.findByText("2 of 5 done")).toBeTruthy();
    expect(screen.getByText("Match the bank feed")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("checklist-toggle-chk_s3"));
    expect(await screen.findByText("3 of 5 done")).toBeTruthy();
    await waitFor(() => expect(transport.calls).toContain("PATCH /checklist-items/chk_s3"));
    const v = await transport.request<{ items: ChecklistItem[] }>("GET", `/tasks/${t.id}/checklist`);
    expect(v.items.find((i) => i.id === "chk_s3")!.done).toBe(true);
  });

  it("rolls the tick back and says so when the server refuses", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const t = await bas();
    mockParams = { id: t.id };
    const Detail = require("@/app/task/[id]").default;
    await wrap(<Detail />);
    expect(await screen.findByText("2 of 5 done")).toBeTruthy();
    transport.failChecklistWrites = true;
    await fireEvent.press(screen.getByTestId("checklist-toggle-chk_s3"));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("That didn't save", "The server had a problem."));
    expect(await screen.findByText("2 of 5 done")).toBeTruthy();
    alert.mockRestore();
  });

  it("adds, renames, moves and deletes items", async () => {
    const t = await bas();
    mockParams = { id: t.id };
    const Detail = require("@/app/task/[id]").default;
    await wrap(<Detail />);
    expect(await screen.findByText("2 of 5 done")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("checklist-input"), "Email the bookkeeper");
    await fireEvent.press(screen.getByTestId("checklist-add"));
    expect(await screen.findByText("2 of 6 done")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("checklist-item-chk_s6")).toBeTruthy());
    expect(screen.getByText("Email the bookkeeper")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("checklist-more-chk_s1"));
    await fireEvent.press(screen.getByTestId("checklist-rename-btn-chk_s1"));
    await fireEvent.changeText(screen.getByTestId("checklist-rename-chk_s1"), "Export takings");
    await fireEvent(screen.getByTestId("checklist-rename-chk_s1"), "submitEditing");
    expect(await screen.findByText("Export takings")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("checklist-more-chk_s1"));
    expect(screen.queryByTestId("checklist-up-chk_s1")).toBeNull();
    await fireEvent.press(screen.getByTestId("checklist-down-chk_s1"));
    await waitFor(() => expect(transport.calls).toContain(`POST /tasks/${t.id}/checklist/reorder`));
    let v = await transport.request<{ items: ChecklistItem[] }>("GET", `/tasks/${t.id}/checklist`);
    expect(v.items.slice(0, 2).map((i) => i.title)).toEqual(["Check GST on the Marrickville takings", "Export takings"]);

    await fireEvent.press(screen.getByTestId("checklist-delete-chk_s1"));
    expect(await screen.findByText("1 of 5 done")).toBeTruthy();
    v = await transport.request("GET", `/tasks/${t.id}/checklist`);
    expect(v.items.map((i) => i.id)).not.toContain("chk_s1");
  });
});

describe("tasks list query box", () => {
  it("shows checklist progress on rows and filters with a typed query", async () => {
    const Tasks = require("@/app/(tabs)/tasks").default;
    await wrap(<Tasks />);
    expect(await screen.findByText("Lodge the September quarter BAS")).toBeTruthy();
    expect(screen.getByText("2/5")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("task-query"), "label:wholesale");
    await fireEvent(screen.getByTestId("task-query"), "submitEditing");
    expect(await screen.findByText("Confirm Saturday wholesale order with Bondi Bakehouse")).toBeTruthy();
    expect(screen.queryByText("Lodge the September quarter BAS")).toBeNull();
    await waitFor(async () => expect(await kv().get(LAST_QUERY_KEY)).toBe("label:wholesale"));
  });

  it("toggles a suggestion chip into the query and clears it", async () => {
    const Tasks = require("@/app/(tabs)/tasks").default;
    await wrap(<Tasks />);
    expect(await screen.findByText("Compare fit out quotes for the Surry Hills kiosk")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Mine"));
    await waitFor(() => expect(screen.queryByText("Compare fit out quotes for the Surry Hills kiosk")).toBeNull());
    expect(screen.getByTestId("task-query").props.value).toBe("assignee:me");
    expect(await screen.findByText("Lodge the September quarter BAS")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("task-query-clear"));
    expect(await screen.findByText("Compare fit out quotes for the Surry Hills kiosk")).toBeTruthy();
  });

  it("shows the server's message in plain words for a bad query", async () => {
    const Tasks = require("@/app/(tabs)/tasks").default;
    await wrap(<Tasks />);
    expect(await screen.findByText("Lodge the September quarter BAS")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("task-query"), "foo:bar");
    await fireEvent(screen.getByTestId("task-query"), "submitEditing");
    expect(await screen.findByTestId("task-query-error")).toBeTruthy();
    expect(screen.getByTestId("task-query-error").props.children).toBe('Unknown key "foo". Check "foo:bar" (character 1).');
    expect(screen.getByText("Check the search")).toBeTruthy();
  });

  it("opens with the remembered query", async () => {
    await kv().set(LAST_QUERY_KEY, "label:invoices");
    const Tasks = require("@/app/(tabs)/tasks").default;
    await wrap(<Tasks />);
    await waitFor(() => expect(screen.getByTestId("task-query").props.value).toBe("label:invoices"));
    expect(await screen.findByText("Chase INV-1042 with Green Roof Cafe")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Lodge the September quarter BAS")).toBeNull());
    await act(async () => {});
  });
});
