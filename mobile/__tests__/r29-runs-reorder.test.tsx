/**
 * R29: agent runs in the app (list and detail, read only) and dragging checklist items into a new
 * order, against the sample workspace (which answers the same session routes as the server).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { ApiError } from "@/api/errors";
import { endpoints } from "@/api/endpoints";
import { durationLabel, formatDuration, orderSteps, runDurationMs, runMeta, runStatus, sortRuns, stepKind } from "@/lib/runs";
import { applyOrder, arrayMove, dragIds, dropIndex, shiftFor } from "@/lib/checklist";
import { liftGesture } from "@/lib/drag";
import { memoryKV, setKV } from "@/lib/kv";
import type { AgentRun, ChecklistItem, RunStep, Task } from "@/api/types";
import type { Method, RequestOptions, Transport } from "@/api/transport";

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

/** The sample workspace, recording every call with its body, with switches for failures. */
class Recording extends SampleTransport {
  calls: { method: string; path: string; body?: unknown }[] = [];
  failChecklistWrites = false;
  runsListMissing = false;
  async request<T>(method: Method, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    this.calls.push({ method, path, body });
    if (this.failChecklistWrites && method !== "GET" && path.includes("checklist")) throw new ApiError(500, "error", "The server had a problem.");
    if (this.runsListMissing && method === "GET" && path.startsWith("/agent-runs?")) throw new ApiError(404, "not_found", "Not found.");
    return super.request<T>(method, path, body, opts);
  }
}

let transport: Recording;
async function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}
const taskBy = async (prefix: string) => (await transport.request<{ tasks: Task[] }>("GET", "/tasks")).tasks.find((t) => t.title.startsWith(prefix))!;

beforeEach(() => { transport = new Recording(); mockPush.mockClear(); mockParams = {}; setKV(memoryKV()); });

const T0 = Date.parse("2026-10-26T03:00:00Z");
const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: "run_1", taskId: "tsk_1", task: { ref: "OPS-1", title: "Task" }, agent: { userId: "u", name: "Bookkeeper" }, status: "succeeded",
  startedAt: "2026-10-26T03:00:00Z", finishedAt: "2026-10-26T03:03:05Z", durationMs: 185_000, result: null, stepCount: 0, steps: [],
  createdAt: "2026-10-26T03:00:00Z", updatedAt: "2026-10-26T03:03:05Z", ...over,
});

describe("run helpers", () => {
  it("names every status with a tone and icon, and reads an unknown one as itself", () => {
    expect(runStatus("queued")).toEqual({ label: "Queued", tone: "neutral", icon: "clock" });
    expect(runStatus("running")).toMatchObject({ label: "Running", tone: "brand" });
    expect(runStatus("succeeded")).toMatchObject({ label: "Succeeded", tone: "ok" });
    expect(runStatus("failed")).toMatchObject({ label: "Failed", tone: "bad" });
    expect(runStatus("cancelled")).toMatchObject({ label: "Cancelled", tone: "neutral" });
    expect(runStatus("timed_out")).toMatchObject({ label: "Timed out", tone: "neutral", icon: "info" });
  });

  it("formats durations in seconds, minutes and hours", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-5)).toBeNull();
    expect(formatDuration(400)).toBe("Under 1s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(4_800_000)).toBe("1h 20m");
    expect(formatDuration(7_200_000)).toBe("2h");
  });

  it("works out a running run's time so far and labels each state", () => {
    expect(runDurationMs(run())).toBe(185_000);
    const live = run({ status: "running", finishedAt: null, durationMs: null });
    expect(runDurationMs(live, T0 + 42_000)).toBe(42_000);
    expect(durationLabel(live, T0 + 42_000)).toBe("42s so far");
    expect(durationLabel(run({ status: "queued", startedAt: null, finishedAt: null, durationMs: null }))).toBe("Not started");
    expect(runDurationMs(run({ durationMs: null, finishedAt: null, status: "failed" }))).toBeNull();
    expect(durationLabel(run())).toBe("3m 05s");
    expect(runMeta(run(), "2:00 pm")).toBe("Started 2:00 pm \u00b7 3m 05s");
    expect(runMeta(run({ status: "queued", startedAt: null }), null)).toBe("Not started yet");
  });

  it("puts steps in time order and keeps the server's order for ties and bad times", () => {
    const steps: RunStep[] = [
      { at: "2026-10-26T03:02:00Z", kind: "tool", text: "c" },
      { at: "2026-10-26T03:00:00Z", kind: "note", text: "a" },
      { at: "2026-10-26T03:01:00Z", kind: "comment", text: "b1" },
      { at: "2026-10-26T03:01:00Z", kind: "status_change", text: "b2" },
    ];
    expect(orderSteps(steps).map((s) => s.text)).toEqual(["a", "b1", "b2", "c"]);
    expect(orderSteps(null)).toEqual([]);
    expect(orderSteps([{ at: "nope", kind: "note", text: "x" }, { at: "nope", kind: "note", text: "y" }]).map((s) => s.text)).toEqual(["x", "y"]);
    expect(stepKind("tool")).toEqual({ label: "Tool", icon: "zap" });
    expect(stepKind("status_change").label).toBe("Status change");
    expect(stepKind("web_fetch").label).toBe("Web fetch");
  });

  it("sorts runs newest first", () => {
    const list = [run({ id: "a", createdAt: "2026-10-26T01:00:00Z" }), run({ id: "b", createdAt: "2026-10-26T02:00:00Z" })];
    expect(sortRuns(list).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("runs API calls", () => {
  it("asks the session routes with the filters", async () => {
    const seen: string[] = [];
    const fake: Transport = { kind: "live", request: async <T,>(m: Method, p: string) => { seen.push(`${m} ${p}`); return { runs: [] } as T; } };
    const api = endpoints(fake);
    await api.runs();
    await api.runs({ status: "failed", agentUserId: "usr_1", limit: 10 });
    await api.run("run 1");
    await api.taskRuns("OPS-12");
    expect(seen).toEqual(["GET /agent-runs?limit=50", "GET /agent-runs?agentUserId=usr_1&status=failed&limit=10", "GET /agent-runs/run%201", "GET /tasks/OPS-12/runs"]);
  });

  it("the sample workspace answers like the server: list without steps, one run and a task's runs", async () => {
    const list = await transport.request<{ runs: AgentRun[] }>("GET", "/agent-runs?limit=50");
    expect(list.runs.map((r) => r.status)).toEqual(["queued", "running", "succeeded", "failed"]);
    expect(list.runs.every((r) => r.steps.length === 0)).toBe(true);
    const failed = await transport.request<{ runs: AgentRun[] }>("GET", "/agent-runs?status=failed");
    expect(failed.runs).toHaveLength(1);
    const one = await transport.request<{ run: AgentRun }>("GET", "/agent-runs/run_s3");
    expect(one.run.steps).toHaveLength(4);
    await expect(transport.request("GET", "/agent-runs/run_nope")).rejects.toMatchObject({ status: 404 });
    const bas = await taskBy("Lodge the September");
    const forTask = await transport.request<{ runs: AgentRun[]; ref: string }>("GET", `/tasks/${bas.ref}/runs`);
    expect(forTask.runs.map((r) => r.id)).toEqual(["run_s4"]);
  });
});

describe("runs screens", () => {
  it("lists runs with status chips, filters, and opens one", async () => {
    const Runs = require("@/app/runs").default;
    await wrap(<Runs />);
    expect(await screen.findByText("Chase INV-1042 with Green Roof Cafe", { exact: false })).toBeTruthy();
    expect(screen.getAllByText("Succeeded").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getByText("Not started yet")).toBeTruthy();
    await fireEvent.press(screen.getAllByText("Failed")[0]);
    await waitFor(() => expect(transport.calls.some((c) => c.path === "/agent-runs?status=failed&limit=50")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("run-run_s3")).toBeNull());
    // M5: wait for the filtered list (the old line raced the reload and failed under load).
    await fireEvent.press(await screen.findByTestId("run-run_s2"));
    expect(mockPush).toHaveBeenCalledWith("/run/run_s2");
  });

  it("shows a calm state when the server doesn't have the list yet", async () => {
    transport.runsListMissing = true;
    const Runs = require("@/app/runs").default;
    await wrap(<Runs />);
    expect(await screen.findByText("Runs list coming soon")).toBeTruthy();
  });

  it("shows a run's steps in order and its result", async () => {
    mockParams = { id: "run_s3" };
    const Detail = require("@/app/run/[id]").default;
    await wrap(<Detail />);
    expect(await screen.findByText("Steps (4)")).toBeTruthy();
    expect(screen.getByTestId("run-step-0")).toHaveProp("accessibilityLabel", expect.stringContaining("Checked INV-1042"));
    expect(screen.getByTestId("run-step-3")).toHaveProp("accessibilityLabel", expect.stringContaining("Moved the task to Done"));
    expect(screen.getByTestId("run-result")).toHaveTextContent(/paid in full/);
    await fireEvent.press(screen.getByTestId("run-task"));
    expect(mockPush).toHaveBeenCalledWith(expect.stringMatching(/^\/task\//));
  });

  it("says when a run is gone", async () => {
    mockParams = { id: "run_nope" };
    const Detail = require("@/app/run/[id]").default;
    await wrap(<Detail />);
    expect(await screen.findByText("Run not found")).toBeTruthy();
  });

  it("shows a task's runs on the task screen", async () => {
    const t = await taskBy("Chase INV-1042");
    mockParams = { id: t.id };
    const Detail = require("@/app/task/[id]").default;
    await wrap(<Detail />);
    expect(await screen.findByTestId("task-runs")).toBeTruthy();
    expect(screen.getByTestId("run-run_s3")).toBeTruthy();
  });
});

const item = (id: string, position: number): ChecklistItem => ({ id, taskId: "tsk_1", title: id, done: false, position, assignee: null, due: null, createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z" });

describe("reorder logic", () => {
  it("moves one entry and clamps out of range targets", () => {
    expect(arrayMove(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(arrayMove(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(arrayMove(["a", "b", "c"], 1, 9)).toEqual(["a", "c", "b"]);
    expect(arrayMove(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    expect(arrayMove([], 0, 1)).toEqual([]);
  });

  it("gives every id once in the new order, or null when nothing moved", () => {
    const list = [item("c", 3), item("a", 1), item("b", 2)];
    expect(dragIds(list, 0, 2)).toEqual(["b", "c", "a"]);
    expect(dragIds(list, 2, 0)).toEqual(["c", "a", "b"]);
    expect(dragIds(list, 1, 1)).toBeNull();
    expect(dragIds(list, 7, 0)).toBeNull();
    const ids = dragIds(list, 0, 1)!;
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
    expect(applyOrder(list, ids).map((i) => [i.id, i.position])).toEqual([["b", 1], ["a", 2], ["c", 3]]);
  });

  it("lands the dragged row once its middle passes a neighbour's middle", () => {
    const h = [50, 50, 80, 50];
    expect(dropIndex(h, 8, 0, 0)).toBe(0);
    expect(dropIndex(h, 8, 0, 28)).toBe(0);
    expect(dropIndex(h, 8, 0, 30)).toBe(1);
    expect(dropIndex(h, 8, 0, 58 + 45)).toBe(2);
    expect(dropIndex(h, 8, 0, 1000)).toBe(3);
    expect(dropIndex(h, 8, 3, -50)).toBe(2);
    expect(dropIndex(h, 8, 3, -1000)).toBe(0);
    expect(dropIndex(h, 8, 9, 10)).toBe(9);
    expect(dropIndex(h, 8, 1, Number.NaN)).toBe(1);
  });

  it("moves the rows in between aside by the dragged row's height", () => {
    expect(shiftFor(1, 0, 2, 50, 8)).toBe(-58);
    expect(shiftFor(2, 0, 2, 50, 8)).toBe(-58);
    expect(shiftFor(3, 0, 2, 50, 8)).toBe(0);
    expect(shiftFor(0, 0, 2, 50, 8)).toBe(0);
    expect(shiftFor(1, 3, 1, 50, 8)).toBe(58);
    expect(shiftFor(0, 3, 1, 50, 8)).toBe(0);
    expect(shiftFor(2, 2, 2, 50, 8)).toBe(0);
  });
});

describe("long press then drag gesture", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const setup = () => {
    const cb = { onStart: jest.fn(), onMove: jest.fn(), onEnd: jest.fn() };
    return { cb, g: liftGesture(cb, 200) };
  };

  it("lifts after the hold, follows the finger and drops with the distance", () => {
    const { cb, g } = setup();
    g.handlers.onPanResponderGrant();
    expect(cb.onStart).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(cb.onStart).toHaveBeenCalledTimes(1);
    expect(g.isActive()).toBe(true);
    expect(g.handlers.onPanResponderTerminationRequest()).toBe(false);
    g.handlers.onPanResponderMove(null, { dx: 0, dy: 40 });
    expect(cb.onMove).toHaveBeenCalledWith(40);
    g.handlers.onPanResponderRelease(null, { dy: 64 });
    expect(cb.onEnd).toHaveBeenCalledWith(64);
    expect(g.isActive()).toBe(false);
  });

  it("lets the page scroll when the finger moves before the hold", () => {
    const { cb, g } = setup();
    g.handlers.onPanResponderGrant();
    g.handlers.onPanResponderMove(null, { dx: 0, dy: 25 });
    jest.advanceTimersByTime(500);
    expect(cb.onStart).not.toHaveBeenCalled();
    expect(g.handlers.onPanResponderTerminationRequest()).toBe(true);
    g.handlers.onPanResponderRelease(null, { dy: 25 });
    expect(cb.onEnd).not.toHaveBeenCalled();
  });

  it("drops nothing when the system takes the touch away", () => {
    const { cb, g } = setup();
    g.handlers.onPanResponderGrant();
    jest.advanceTimersByTime(250);
    g.handlers.onPanResponderTerminate();
    expect(cb.onEnd).toHaveBeenCalledWith(null);
  });

  it("reads the newest callbacks each time", () => {
    let current = { onStart: jest.fn(), onMove: jest.fn(), onEnd: jest.fn() };
    const g = liftGesture(() => current, 100);
    g.handlers.onPanResponderGrant();
    current = { onStart: jest.fn(), onMove: jest.fn(), onEnd: jest.fn() };
    jest.advanceTimersByTime(100);
    expect(current.onStart).toHaveBeenCalled();
  });
});

describe("checklist reorder on the task screen", () => {
  const openBas = async () => {
    const t = await taskBy("Lodge the September");
    mockParams = { id: t.id };
    const Detail = require("@/app/task/[id]").default;
    await wrap(<Detail />);
    expect(await screen.findByText("2 of 5 done")).toBeTruthy();
    return t;
  };
  const order = async (taskId: string) => (await transport.request<{ items: ChecklistItem[] }>("GET", `/tasks/${taskId}/checklist`)).items.map((i) => i.id);

  it("has a grip with Move up and Move down for screen readers, and sends the whole new order", async () => {
    const t = await openBas();
    const grip = screen.getByTestId("checklist-drag-chk_s1");
    expect(grip.props.accessibilityLabel).toBe("Reorder Export the stall takings from Square");
    expect(grip.props.accessibilityActions).toEqual([{ name: "moveDown", label: "Move down" }]);
    expect(screen.getByTestId("checklist-drag-chk_s3").props.accessibilityActions.map((a: { name: string }) => a.name)).toEqual(["moveUp", "moveDown"]);
    await fireEvent(grip, "accessibilityAction", { nativeEvent: { actionName: "moveDown" } });
    await waitFor(() => expect(transport.calls.some((c) => c.method === "POST" && c.path.endsWith("/checklist/reorder"))).toBe(true));
    const sent = transport.calls.find((c) => c.method === "POST" && c.path.endsWith("/checklist/reorder"))!.body as { ids: string[] };
    expect(sent.ids).toEqual(["chk_s2", "chk_s1", "chk_s3", "chk_s4", "chk_s5"]);
    expect(await order(t.id)).toEqual(sent.ids);
  });

  it("shows the new order at once and puts it back with a short message if the server says no", async () => {
    await openBas();
    transport.failChecklistWrites = true;
    await fireEvent(screen.getByTestId("checklist-drag-chk_s5"), "accessibilityAction", { nativeEvent: { actionName: "moveUp" } });
    expect(await screen.findByTestId("checklist-order-error")).toHaveTextContent("Order not saved. The server had a problem.");
    const ids = screen.getAllByTestId(/^checklist-item-/).map((n) => n.props.testID.replace("checklist-item-", ""));
    expect(ids).toEqual(["chk_s1", "chk_s2", "chk_s3", "chk_s4", "chk_s5"]);
  });

  it("lifts an item after a hold on the grip, drags it two rows down and saves the whole order", async () => {
    const t = await openBas();
    for (const id of ["chk_s1", "chk_s2", "chk_s3", "chk_s4", "chk_s5"]) {
      await fireEvent(screen.getByTestId(`checklist-item-${id}`), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 50 } } });
    }
    const grip = screen.getByTestId("checklist-drag-chk_s1");
    let ts = 1000;
    let lastY = 100;
    const touch = (y: number, startY = 100, active = true) => {
      ts += 16;
      const prevY = lastY;
      lastY = y;
      return {
        nativeEvent: { touches: active ? [{ pageX: 10, pageY: y }] : [], changedTouches: [{ pageX: 10, pageY: y }], pageX: 10, pageY: y, timestamp: ts },
        touchHistory: { numberActiveTouches: active ? 1 : 0, indexOfSingleActiveTouch: 0, mostRecentTimeStamp: ts,
          touchBank: [{ touchActive: active, startPageX: 10, startPageY: startY, startTimeStamp: 1000, currentPageX: 10, currentPageY: y, currentTimeStamp: ts, previousPageX: 10, previousPageY: prevY, previousTimeStamp: ts - 16 }] },
      };
    };
    jest.useFakeTimers();
    try {
      await fireEvent(grip, "responderGrant", touch(100));
      await act(async () => { jest.advanceTimersByTime(250); });
      expect(screen.getByText("Hold the grip to drag an item into place.")).toBeTruthy();
      await fireEvent(grip, "responderMove", touch(160));
      await fireEvent(grip, "responderMove", touch(220));
      await fireEvent(grip, "responderRelease", touch(220, 100, false));
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(transport.calls.some((c) => c.method === "POST" && c.path.endsWith("/checklist/reorder"))).toBe(true));
    const sent = transport.calls.find((c) => c.method === "POST" && c.path.endsWith("/checklist/reorder"))!.body as { ids: string[] };
    expect(sent.ids).toEqual(["chk_s2", "chk_s3", "chk_s1", "chk_s4", "chk_s5"]);
    expect(await order(t.id)).toEqual(sent.ids);
  });

  it("has no grip when the checklist is read only", async () => {
    const t = await taskBy("Lodge the September");
    const { ChecklistSection } = require("@/components/checklist");
    await wrap(<ChecklistSection taskId={t.id} readOnly />);
    expect(await screen.findByText("2 of 5 done")).toBeTruthy();
    expect(screen.queryByTestId("checklist-drag-chk_s1")).toBeNull();
  });
});
