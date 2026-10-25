import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { renameReferences } from "@/server/services/suite/formula-rename";

describe("renameReferences", () => {
  it("rewrites braced references in any case and bare words, not text in quotes or function names", () => {
    expect(renameReferences("{Budget} * 1.1", "Budget", "Spend")).toBe("{Spend} * 1.1");
    expect(renameReferences("{budget} + { BUDGET } + budget", "Budget", "Total spend")).toBe("{Total spend} + {Total spend} + {Total spend}");
    expect(renameReferences(`if({Budget} > 0, "Budget ok", 'budget')`, "Budget", "Spend")).toBe(`if({Spend} > 0, "Budget ok", 'budget')`);
    expect(renameReferences("round({Round} + round(2))", "Round", "Rounded")).toBe("round({Rounded} + round(2))");
    expect(renameReferences("{Budgeted} + {Budget}", "Budget", "Spend")).toBe("{Budgeted} + {Spend}");
  });
  it("leaves expressions alone when nothing matches, the text can't be read, or the new name can't be braced", () => {
    expect(renameReferences("{Cost} * 2", "Budget", "Spend")).toBe("{Cost} * 2");
    expect(renameReferences("{Budget", "Budget", "Spend")).toBe("{Budget");
    expect(renameReferences("{Budget} * 2", "Budget", "Odd}name")).toBe("{Budget} * 2");
  });
});

describe("renaming a field rewrites the project's formulas", () => {
  it("updates every formula that reads it, keeps them computing, and leaves other projects and orgs alone", async () => {
    const ctx = await makeTestApp();
    const u = new Client(ctx.app);
    await u.signup("owner@acme.io", "Olive Owner");
    const projectId = (await u.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
    const other = (await u.post("/api/projects", { name: "Other", key: "OTH" })).body.project.id;
    const budget = (await u.post("/api/fields", { projectId, name: "Budget", type: "number" })).body.field;
    const tax = (await u.post("/api/fields", { projectId, name: "Tax", type: "formula", config: { expression: "{budget} * 0.1" } })).body.field;
    const gross = (await u.post("/api/fields", { projectId, name: "Gross", type: "formula", config: { expression: "{BUDGET} + {Tax}" } })).body.field;
    const plain = (await u.post("/api/fields", { projectId, name: "Double points", type: "formula", config: { expression: "points * 2" } })).body.field;
    await u.post("/api/fields", { projectId: other, name: "Budget", type: "number" });
    const otherF = (await u.post("/api/fields", { projectId: other, name: "Mirror", type: "formula", config: { expression: "{Budget}" } })).body.field;
    const t = (await u.post("/api/tasks", { title: "Ship", projectId })).body.task;
    await u.patch(`/api/tasks/${t.id}`, { fields: { [budget.id]: 100 } });

    const r = await u.patch(`/api/fields/${budget.id}`, { name: "Spend" });
    expect(r.status).toBe(200);
    const list = (await u.get(`/api/fields?projectId=${projectId}`)).body.fields as { id: string; config?: { expression?: string } }[];
    const byId = new Map(list.map((f) => [f.id, f]));
    expect(byId.get(tax.id)!.config!.expression).toBe("{Spend} * 0.1");
    expect(byId.get(gross.id)!.config!.expression).toBe("{Spend} + {Tax}");
    expect(byId.get(plain.id)!.config!.expression).toBe("points * 2");
    const otherList = (await u.get(`/api/fields?projectId=${other}`)).body.fields as { id: string; config?: { expression?: string } }[];
    expect(otherList.find((f) => f.id === otherF.id)!.config!.expression).toBe("{Budget}");
    const computed = (await u.get(`/api/computed/tasks/${t.id}`)).body;
    expect(JSON.stringify(computed)).not.toMatch(/no field called/i);

    // Renaming a formula field rewrites the formulas that read it too.
    expect((await u.patch(`/api/fields/${tax.id}`, { name: "GST" })).status).toBe(200);
    const after = (await u.get(`/api/fields?projectId=${projectId}`)).body.fields as { id: string; config?: { expression?: string } }[];
    expect(after.find((f) => f.id === gross.id)!.config!.expression).toBe("{Spend} + {GST}");

    // Another workspace can't rename this field.
    const x = new Client(ctx.app);
    await x.signup("eve@evil.io", "Eve Other");
    expect((await x.patch(`/api/fields/${budget.id}`, { name: "Hacked" })).status).toBe(404);
    const still = (await u.get(`/api/fields?projectId=${projectId}`)).body.fields as { id: string; name: string; config?: { expression?: string } }[];
    expect(still.find((f) => f.id === budget.id)!.name).toBe("Spend");
    expect(still.find((f) => f.id === gross.id)!.config!.expression).toBe("{Spend} + {GST}");
  });
});
