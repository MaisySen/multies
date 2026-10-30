import { ApiError } from "@/api/errors";
import type { CustomField, FieldValue, PortfolioProject, Task } from "@/api/types";
import type { SampleWork } from "./tasks";
import type { SampleExtras } from "./time-meetings";

/**
 * Custom fields and the portfolio for the sample workspace. One field of every type on the
 * Operations project, a few values on the sample tasks, and two more projects so the portfolio
 * has something to compare.
 */
export function sampleFields(projectId: string): CustomField[] {
  const f = (id: string, name: string, type: CustomField["type"], position: number, options: CustomField["options"] = []): CustomField => ({ id, projectId, name, type, options, position });
  return [
    f("fld_budget", "Budget", "currency", 0),
    f("fld_client", "Client", "select", 1, [
      { id: "opt_bondi", label: "Bondi Bakehouse", color: "#A3824A" },
      { id: "opt_greenroof", label: "Green Roof Cafe", color: "#5E8C61" },
      { id: "opt_internal", label: "Harbour Coffee Co", color: "#5B7FA6" },
    ]),
    f("fld_approved", "Approved", "checkbox", 2),
    f("fld_signoff", "Sign off by", "date", 3),
    f("fld_hours", "Estimate (hours)", "number", 4),
    f("fld_channels", "Channels", "multiselect", 5, [
      { id: "opt_email", label: "Email", color: "#5B7FA6" },
      { id: "opt_phone", label: "Phone", color: "#4F8A8B" },
      { id: "opt_stall", label: "Market stall", color: "#7D6B9E" },
    ]),
    f("fld_reviewer", "Reviewer", "person", 6),
    f("fld_link", "Supplier page", "url", 7),
    f("fld_po", "PO number", "text", 8),
  ];
}

/** Puts a few values on the sample tasks, matched by title. */
export function seedFieldValues(work: SampleWork, day: (d: number) => string) {
  const set = (start: string, values: Record<string, FieldValue>) => {
    const t = work.tasks.find((x) => x.title.startsWith(start));
    if (t) t.fields = { ...values };
  };
  set("Confirm Saturday wholesale order", { fld_budget: 1250, fld_client: "opt_bondi", fld_approved: true, fld_signoff: day(1), fld_hours: 1.5, fld_channels: ["opt_email", "opt_phone"], fld_reviewer: "member:usr_josh", fld_po: "BB-2207" });
  set("Chase INV-1042", { fld_budget: 2840.5, fld_client: "opt_greenroof", fld_channels: ["opt_email"], fld_reviewer: "member:usr_sample" });
  set("Compare fit out quotes", { fld_budget: 18500, fld_client: "opt_internal", fld_signoff: day(9), fld_hours: 6, fld_link: "https://example.com.au/kiosk-joinery" });
  set("Lodge the September quarter BAS", { fld_client: "opt_internal", fld_approved: true, fld_hours: 3 });
  for (const t of work.tasks) t.fields ??= {};
}

/** Validates and applies PATCH /tasks/:id { fields }, the way the server does. */
export function applyFieldPatch(fields: CustomField[], t: Task, patch: Record<string, FieldValue | null>) {
  const next = { ...(t.fields ?? {}) };
  for (const [id, value] of Object.entries(patch)) {
    const f = fields.find((x) => x.id === id && x.projectId === t.projectId);
    if (!f) throw new ApiError(422, "unknown_field", "That field isn't on this task's project.");
    if (value === null) { delete next[id]; continue; }
    if (!fits(f, value)) throw new ApiError(422, "validation_error", `That isn't a valid value for ${f.name}.`);
    // As on the server, an unticked checkbox is stored as no value.
    if (value === false || (Array.isArray(value) && !value.length)) delete next[id];
    else next[id] = value;
  }
  t.fields = next;
}

function fits(f: CustomField, v: FieldValue): boolean {
  switch (f.type) {
    case "text": case "url": return typeof v === "string";
    case "number": case "currency": return typeof v === "number" && Number.isFinite(v);
    case "date": return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    case "checkbox": return typeof v === "boolean";
    case "select": return typeof v === "string" && f.options.some((o) => o.id === v);
    case "multiselect": return Array.isArray(v) && v.every((x) => f.options.some((o) => o.id === x));
    case "person": return typeof v === "string" && /^(member|agent):/.test(v);
    default: return false;
  }
}

/** GET /portfolio: the live Operations project worked out from the sample tasks, plus two fixed ones. */
export function samplePortfolio(work: SampleWork, extras: SampleExtras, now: number): { projects: PortfolioProject[] } {
  const today = new Date(now).toISOString().slice(0, 10);
  const top = work.tasks.filter((t) => !t.parentId);
  const done = top.filter((t) => t.status === "done").length;
  const open = top.filter((t) => t.status !== "done" && t.due);
  const next = [...open].filter((t) => t.due!.slice(0, 10) >= today).sort((a, b) => a.due!.localeCompare(b.due!))[0] ?? null;
  const seconds = extras.entries.filter((e) => e.projectId === work.project.id).reduce((n, e) => n + (e.running ? Math.floor((now - Date.parse(e.startedAt)) / 1000) : e.seconds), 0);
  const day = (d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10);
  const ops: PortfolioProject = {
    id: work.project.id, name: work.project.name, key: work.project.key, color: work.project.color, archived: false,
    owner: { id: "usr_sample", name: "Mia Nguyen" }, health: "at_risk", healthNote: "INV-1042 is a day overdue. Waiting on the remittance.",
    progress: top.length ? Math.round((done / top.length) * 100) : 0, total: top.length, done,
    overdue: open.filter((t) => t.due!.slice(0, 10) < today).length, timeLoggedSeconds: seconds,
    nextDue: next?.due ?? null, nextDueTask: next ? { id: next.id, ref: next.ref, title: next.title } : null,
  };
  return {
    projects: [
      ops,
      { id: "prj_kiosk", name: "Surry Hills kiosk", key: "KSK", color: "#4F8A8B", archived: false, owner: { id: "usr_josh", name: "Josh Tran" },
        health: "on_track", healthNote: null, progress: 35, total: 20, done: 7, overdue: 0, timeLoggedSeconds: 14 * 3600 + 20 * 60,
        nextDue: day(6), nextDueTask: null },
      { id: "prj_markets", name: "Marrickville Markets stall", key: "MKT", color: "#7D6B9E", archived: false, owner: null,
        health: null, healthNote: null, progress: 80, total: 10, done: 8, overdue: 1, timeLoggedSeconds: 5 * 3600 + 5 * 60,
        nextDue: null, nextDueTask: null },
    ],
  };
}
