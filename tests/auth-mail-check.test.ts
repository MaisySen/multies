import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript script without types
import { judge, windowStart } from "../scripts/auth-mail-check.mjs";

const on = { name: "smtp", enabled: true };

describe("sign in mail check (27 Oct 2026 outage)", () => {
  it("passes when the provider is on, nothing failed and the probe was accepted", () => {
    expect(judge({ provider: on, failures: [], probe: { event: "delivered" } })).toEqual({ ok: true, problems: [] });
    expect(judge({ provider: on, failures: [] }).ok).toBe(true);
  });

  it("fails on the revoked key error the tenant logged on 26 and 27 Oct", () => {
    const v = judge({ provider: on, failures: [{ date: "2026-10-27T00:22:17Z", to: "someone@example.com", error: "Error sending email: Invalid login: 535 Authentication credentials invalid" }] });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain("535");
  });

  it("fails when the email provider is off or missing", () => {
    expect(judge({ provider: { name: "smtp", enabled: false } }).ok).toBe(false);
    expect(judge({ provider: null }).ok).toBe(false);
  });

  it("fails when the probe email failed, never arrived, or was bounced", () => {
    expect(judge({ provider: on, probe: { authFailure: "535" } }).ok).toBe(false);
    expect(judge({ provider: on, probe: {} }).ok).toBe(false);
    expect(judge({ provider: on, probe: { event: "bounced" } }).ok).toBe(false);
    expect(judge({ provider: on, probe: { event: "sent" } }).ok).toBe(true);
  });

  it("counts failures only since the last email provider change", () => {
    const now = Date.parse("2026-10-27T01:00:00Z");
    expect(windowStart(now, 30)).toBe("2026-10-27T00:30:00.000Z");
    expect(windowStart(now, 30, "2026-10-27T00:46:31.594Z")).toBe("2026-10-27T00:46:31.594Z");
    expect(windowStart(now, 30, "2026-10-26T00:00:00Z")).toBe("2026-10-27T00:30:00.000Z");
  });
});
