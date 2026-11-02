/**
 * M2 (1.10.10): the sample workspace's expenses (GET /api/expenses, GET /api/expenses/:id, PUT /api/expenses/upload,
 * POST /api/expenses/:id/read | submit | withdraw), the same shape as the web (R106). The sample person is an approver.
 */
import { ApiError } from "@/api/errors";
import type { Expense, ExpensesResponse } from "@/lib/expenses";

const day = 86_400_000;
export function sampleExpenses(now = Date.now()): Expense[] {
  const e = (id: string, supplier: string | null, total: number | null, gst: number | null, status: string, ago: number, own = true, extra: Partial<Expense> = {}): Expense => ({
    id, own, status, supplier, totalCents: total, gstCents: gst, currency: "AUD", spentOn: new Date(now - ago * day).toISOString().slice(0, 10), category: supplier ? "Travel" : null,
    userName: own ? "Alex Sample" : "Priya Raman", hasFile: true, fileName: `${(supplier ?? "receipt").toLowerCase().replace(/\s+/g, "-")}.jpg`, readState: "done", createdAt: new Date(now - ago * day).toISOString(), ...extra,
  });
  return [
    e("exp_s1", "Harbour Fuel", 8640, 785, "draft", 0),
    e("exp_s2", "Officeworks", 12999, 1182, "submitted", 2),
    e("exp_s3", "Qantas", 34900, 3173, "approved", 6, true, { category: "Flights", decidedByName: "Sam Admin" }),
    e("exp_s4", "Greenleaf Cafe", 4250, 386, "submitted", 1, false),
    e("exp_s5", "Parking Plus", 1800, 164, "rejected", 9, true, { rejectReason: "Personal trip, not a client visit.", decidedByName: "Sam Admin" }),
  ];
}

export function expensesRoute(store: { items: Expense[]; seq: number }, method: string, path: string, params: Record<string, string>, body: unknown): unknown {
  if (path !== "/expenses" && !path.startsWith("/expenses/")) return undefined;
  if (method === "GET" && path === "/expenses") {
    const view = params.view === "approve" ? "approve" : "mine";
    const items = view === "approve" ? store.items.filter((x) => !x.own && x.status === "submitted") : store.items.filter((x) => x.own);
    return { expenses: items, next: null, waiting: store.items.filter((x) => !x.own && x.status === "submitted").length, canApprove: true, canManage: true } satisfies ExpensesResponse;
  }
  if (method === "PUT" && path === "/expenses/upload") {
    const name = (body as { name?: string } | null)?.name ?? "receipt";
    const x: Expense = { id: `exp_n${store.seq++}`, own: true, status: "draft", supplier: null, totalCents: null, gstCents: null, currency: "AUD", spentOn: null,
      hasFile: true, fileName: name, readState: "pending", userName: "Alex Sample", createdAt: new Date().toISOString() };
    store.items.unshift(x);
    return { expense: x };
  }
  const [id, action] = path.slice("/expenses/".length).split("/").map(decodeURIComponent);
  const x = store.items.find((i) => i.id === id);
  if (!x) throw new ApiError(404, "not_found", "Expense not found.");
  if (method === "GET" && !action) return { expense: x };
  if (method === "POST" && action === "read") { Object.assign(x, { readState: "done", supplier: x.supplier ?? "Corner Store", totalCents: x.totalCents ?? 2350, gstCents: x.gstCents ?? 214, spentOn: x.spentOn ?? new Date().toISOString().slice(0, 10) }); return { expense: x }; }
  if (method === "POST" && action === "submit") { Object.assign(x, { status: "submitted" }); return { expense: x }; }
  if (method === "POST" && action === "withdraw") { Object.assign(x, { status: "draft" }); return { expense: x }; }
  return undefined;
}
