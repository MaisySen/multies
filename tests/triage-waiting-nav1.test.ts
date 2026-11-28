import { describe, it, expect } from "vitest";
import { triageWaitingLine } from "@/web/lib/triage-waiting-nav1";
import { t } from "@/web/i18n";
import { en } from "@/web/i18n/en";
import { hi } from "@/web/i18n/hi";
import { ne } from "@/web/i18n/ne";

/** MPT-11 (NAV1 slice 2): when the "N waiting in Triage" line shows above a project's tasks, and where it links. */
const base = { projectId: "prj_1", triageOn: true, view: "board", count: 2, failed: false };

describe("N waiting in Triage line (MPT-11)", () => {
  it("shows on the board and the list of a project with Triage on and items waiting, and links to the filtered Triage page", () => {
    expect(triageWaitingLine(base)).toEqual({ count: 2, href: "/app/triage?project=prj_1" });
    expect(triageWaitingLine({ ...base, view: "list", count: 1 })).toEqual({ count: 1, href: "/app/triage?project=prj_1" });
  });

  it("is hidden when nothing waits, Triage is off, no project is picked, or the view is not board or list", () => {
    expect(triageWaitingLine({ ...base, count: 0 })).toBeNull();
    expect(triageWaitingLine({ ...base, count: undefined })).toBeNull();
    expect(triageWaitingLine({ ...base, triageOn: false })).toBeNull();
    expect(triageWaitingLine({ ...base, projectId: "" })).toBeNull();
    expect(triageWaitingLine({ ...base, projectId: null })).toBeNull();
    for (const view of ["calendar", "timeline", "sprints", "workload", "mindmap"]) expect(triageWaitingLine({ ...base, view })).toBeNull();
  });

  it("is hidden for anyone the count read refuses (no workspace session, the same rule as the Triage page)", () => {
    expect(triageWaitingLine({ ...base, failed: true })).toBeNull();
  });

  it("encodes the project id in the link", () => {
    expect(triageWaitingLine({ ...base, projectId: "a b&c" })?.href).toBe("/app/triage?project=a%20b%26c");
  });

  it("has the text in English, Hindi and Nepali, with the count", () => {
    expect(t("tasks.n_waiting_in_triage", { count: 3 })).toBe("3 waiting in Triage");
    for (const bundle of [en, hi, ne]) expect(String(bundle["tasks.n_waiting_in_triage"])).toContain("{count}");
  });
});
