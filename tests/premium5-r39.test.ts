import { describe, expect, it } from "vitest";
import { connectionStatus, factorStatus, isRoleLocalPart, mailboxKind, ROLE_LOCAL_PARTS, PLAIN_STATUS_LABELS, teamHeadline } from "@/web/lib/premium5-r39";

describe("R39 premium pass 5 rules", () => {
  const box = { id: "b1", localPart: "ana" };
  it("reads a mailbox kind from who can open it", () => {
    expect(mailboxKind(box, [])).toBe("personal");
    expect(mailboxKind(box, [{ kind: "human", mailboxIds: ["b1"] }])).toBe("personal");
    expect(mailboxKind(box, [{ kind: "human", mailboxIds: ["b1"] }, { kind: "human", mailboxIds: ["b1", "b2"] }])).toBe("shared");
    expect(mailboxKind(box, [{ kind: "human", mailboxIds: ["b1"] }, { kind: "agent", mailboxIds: ["b1"] }])).toBe("agent");
    // owners and admins (a null list) are not counted
    expect(mailboxKind(box, [{ kind: "human", mailboxIds: null }, { kind: "human", mailboxIds: null }])).toBe("personal");
  });
  it("treats role addresses as shared", () => {
    expect(mailboxKind({ id: "x", localPart: "Support" }, [])).toBe("shared");
    expect(mailboxKind({ id: "x", localPart: "sales" }, [])).toBe("shared");
  });
  it("R40: founders@ and the other common shared names read as Shared, from one list", () => {
    for (const name of ["founders", "team", "info", "contact", "sales", "office", "accounts", "finance", "careers", "jobs", "press", "media", "partners", "marketing", "orders"]) {
      expect(ROLE_LOCAL_PARTS.has(name)).toBe(true);
      expect(mailboxKind({ id: "x", localPart: name }, [{ kind: "human", mailboxIds: ["x"] }])).toBe("shared");
    }
    expect(mailboxKind({ id: "x", localPart: "Founders" }, [])).toBe("shared");
    expect(isRoleLocalPart("sales+eu")).toBe(true);
    expect(isRoleLocalPart("info.nz")).toBe(true);
    expect(isRoleLocalPart("ana")).toBe(false);
    expect(isRoleLocalPart("alex.rivera")).toBe(false);
    // personal still wins for a named person with one opener, and agents still win over role names
    expect(mailboxKind({ id: "x", localPart: "ana" }, [{ kind: "human", mailboxIds: ["x"] }])).toBe("personal");
    expect(mailboxKind({ id: "x", localPart: "support" }, [{ kind: "agent", mailboxIds: ["x"] }])).toBe("agent");
    // the list stays lower case with no duplicates
    const all = [...ROLE_LOCAL_PARTS];
    expect(all.every((n) => n === n.toLowerCase())).toBe(true);
  });
  it("puts factors in plain words", () => {
    expect(factorStatus("good")).toBe("good");
    expect(factorStatus("warn")).toBe("check");
    expect(factorStatus("bad")).toBe("check");
    expect(factorStatus("unknown")).toBe("unset");
    expect(Object.values(PLAIN_STATUS_LABELS)).toEqual(["Good", "Check this", "Not set up"]);
  });
  it("names one next step for a connection that needs it", () => {
    expect(connectionStatus("active")).toEqual({ status: "good", next: null });
    expect(connectionStatus("syncing").next).toBeNull();
    for (const s of ["auth_failed", "error", "paused"] as const) {
      const r = connectionStatus(s);
      expect(r.status).toBe("check");
      expect(r.next).toMatch(/\.$/);
      expect(r.next).not.toMatch(/[\u2013\u2014]/);
    }
  });
  it("counts seats left and never goes below zero", () => {
    expect(teamHeadline({ members: 3, pendingInvites: 1, limit: 10 })).toEqual({ people: 3, pending: 1, seatsLeft: 6 });
    expect(teamHeadline({ members: 5, pendingInvites: 2, limit: 5 }).seatsLeft).toBe(0);
  });
});
