import { formatAud, formatDay, hm, parseAmount, parseDay, showValue, sortPortfolio } from "@/lib/fields";
import { SampleTransport } from "@/sample/transport";
import type { CustomField, PortfolioProject, TaskView } from "@/api/types";

const field = (type: CustomField["type"], options: CustomField["options"] = []): CustomField => ({ id: "f", projectId: "p", name: "F", type, options, position: 0 });
const opts = [{ id: "o1", label: "Bondi Bakehouse", color: "#f5a524" }, { id: "o2", label: "Green Roof Cafe", color: null }];

describe("custom field values", () => {
  it("formats AUD, en-AU dates and h:mm", () => {
    expect(formatAud(1250)).toBe("A$1,250.00");
    expect(formatAud(-12.5)).toMatch(/^-A\$12\.50$/);
    expect(formatDay("2026-10-24")).toBe("24 Oct 2026");
    expect(formatDay("2026-01-01")).toBe("1 Jan 2026");
    expect(hm(0)).toBe("0:00");
    expect(hm(3 * 3600 + 5 * 60 + 59)).toBe("3:05");
    expect(hm(41 * 3600 + 30 * 60)).toBe("41:30");
  });

  it("shows every type, and a dash when empty", () => {
    const people = [{ id: "member:u1", name: "Josh Tran" }, { id: "agent:a1", name: "Invoice chaser" }];
    expect(showValue(field("text"), "BB-2207").text).toBe("BB-2207");
    expect(showValue(field("url"), "https://example.com.au").text).toBe("https://example.com.au");
    expect(showValue(field("number"), 1.5).text).toBe("1.5");
    expect(showValue(field("number"), 12000).text).toBe("12,000");
    expect(showValue(field("currency"), 2840.5).text).toBe("A$2,840.50");
    expect(showValue(field("date"), "2026-10-24").text).toBe("24 Oct 2026");
    expect(showValue(field("checkbox"), true).text).toBe("Yes");
    expect(showValue(field("checkbox"), false).text).toBe("No");
    expect(showValue(field("select", opts), "o1")).toEqual({ empty: false, text: "Bondi Bakehouse", chips: [{ label: "Bondi Bakehouse", color: "#f5a524" }] });
    expect(showValue(field("multiselect", opts), ["o1", "o2", "gone"]).chips).toHaveLength(2);
    expect(showValue(field("person"), "member:u1", people).text).toBe("Josh Tran");
    expect(showValue(field("person"), "agent:a1", people).text).toBe("Invoice chaser");
    for (const v of [null, undefined, ""]) expect(showValue(field("text"), v)).toEqual({ empty: true, text: "-" });
    expect(showValue(field("select", opts), "missing").empty).toBe(true);
    expect(showValue(field("multiselect", opts), []).empty).toBe(true);
    expect(showValue(field("currency"), "12").empty).toBe(true);
  });

  it("reads typed amounts and Australian dates", () => {
    expect(parseAmount("A$1,250.50")).toBe(1250.5);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseDay("24/10/2026")).toBe("2026-10-24");
    expect(parseDay("2026-10-24")).toBe("2026-10-24");
    expect(parseDay("31/02/2026")).toBeNull();
    expect(parseDay("10/24/2026")).toBeNull();
  });
});

describe("sample workspace fields and portfolio", () => {
  it("returns the project's fields with the task and sets values", async () => {
    const t = new SampleTransport();
    const { tasks } = await t.request<{ tasks: { id: string; title: string; fields?: Record<string, unknown> }[] }>("GET", "/tasks");
    const order = tasks.find((x) => x.title.startsWith("Confirm Saturday"))!;
    expect(order.fields?.fld_budget).toBe(1250);
    const d = await t.request<TaskView>("GET", `/tasks/${order.id}`);
    expect(d.customFields?.map((f) => f.type)).toEqual(["currency", "select", "checkbox", "date", "number", "multiselect", "person", "url", "text"]);
    const r = await t.request<{ task: { fields: Record<string, unknown> } }>("PATCH", `/tasks/${order.id}`, { fields: { fld_approved: false, fld_po: null, fld_client: "opt_greenroof" } });
    expect(r.task.fields).toMatchObject({ fld_approved: false, fld_client: "opt_greenroof" });
    expect(r.task.fields.fld_po).toBeUndefined();
    await expect(t.request("PATCH", `/tasks/${order.id}`, { fields: { fld_client: "nope" } })).rejects.toMatchObject({ status: 422 });
    await expect(t.request("PATCH", `/tasks/${order.id}`, { fields: { fld_budget: "lots" } })).rejects.toMatchObject({ status: 422 });
    await expect(t.request("PATCH", `/tasks/${order.id}`, { fields: { fld_unknown: 1 } })).rejects.toMatchObject({ status: 422 });
  });

  it("works out the portfolio from the sample tasks", async () => {
    const t = new SampleTransport();
    const { projects } = await t.request<{ projects: PortfolioProject[] }>("GET", "/portfolio");
    const ops = projects.find((p) => p.key === "OPS")!;
    expect(ops.total).toBe(5);
    expect(ops.done).toBe(1);
    expect(ops.progress).toBe(20);
    expect(ops.overdue).toBe(1);
    expect(ops.timeLoggedSeconds).toBe((80 + 45 + 25) * 60);
    expect(ops.nextDueTask?.title).toMatch(/Confirm Saturday/);
    expect(projects.map((p) => p.health)).toEqual(["at_risk", "on_track", null]);
    const sorted = sortPortfolio([{ ...ops, archived: true, name: "A" }, { ...ops, name: "Z" }, { ...ops, name: "B" }]);
    expect(sorted.map((p) => p.name)).toEqual(["B", "Z", "A"]);
  });
});
