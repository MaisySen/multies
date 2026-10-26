/* eslint-disable @typescript-eslint/no-require-imports */
const { evaluateHealth, ageHoursFrom, rowsFromDiscover, projectIdFromEnv, discoverQuery, fetchHealthRows } = require("../scripts/ota-health");

const rows = (applied: number, crash = 0, failed = 0, launchCrash = 0) => [
  { event: "applied", users: applied, count: applied },
  { event: "crash", users: crash, count: crash },
  { event: "launch_crash", users: launchCrash, count: launchCrash },
  { event: "failed", users: failed, count: failed },
];

describe("rollout health", () => {
  it("is healthy with enough installs and a low crash rate", () => {
    const h = evaluateHealth(rows(200, 2));
    expect(h.verdict).toBe("healthy");
    expect(h.crashRate).toBeCloseTo(1);
  });
  it("rolls back above the crash threshold", () => {
    expect(evaluateHealth(rows(100, 2, 0, 2)).verdict).toBe("rollback");
    expect(evaluateHealth(rows(100, 3), { maxCrashRate: 2 }).verdict).toBe("rollback");
  });
  it("rolls back on many crashes even on a small sample", () => {
    expect(evaluateHealth(rows(6, 5)).verdict).toBe("rollback");
  });
  it("holds on a crash with too little data, and waits with none", () => {
    expect(evaluateHealth(rows(5, 1)).verdict).toBe("halt");
    expect(evaluateHealth(rows(5)).verdict).toBe("wait");
  });
  it("halts when the update fails to load on too many phones", () => {
    expect(evaluateHealth(rows(100, 0, 10)).verdict).toBe("halt");
  });
  it("reads Sentry Discover rows and builds the query", () => {
    expect(rowsFromDiscover({ data: [{ ota_event: "applied", "count_unique(user)": 3, "count()": 4 }, { ota_event: "crash", "count_unique(user)": 1, "count()": 1 }] }))
      .toEqual([{ event: "applied", users: 3, count: 4 }, { event: "crash", users: 1, count: 1 }]);
    expect(discoverQuery(["a"])).toBe("update_id:a");
    expect(discoverQuery(["a", "b"])).toBe("update_id:[a,b]");
    expect(() => discoverQuery([])).toThrow();
    expect(projectIdFromEnv({ SENTRY_DSN_WEB: "https://k@o1.ingest.sentry.io/4512303525330944" })).toBe("4512303525330944");
  });
  it("calls the Sentry events API with the token and counts distinct installs", async () => {
    const calls: { url: string; auth: string }[] = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers.authorization });
      return { ok: true, json: async () => ({ data: [{ ota_event: "applied", "count_unique(user)": 3, "count()": 3 }] }) };
    };
    const r = await fetchHealthRows(["u1", "u2"], { SENTRY_OPS_TOKEN: "tok", SENTRY_ORG: "org", SENTRY_PROJECT_ID: "9" }, fetchImpl);
    expect(r).toEqual([{ event: "applied", users: 3, count: 3 }]);
    expect(calls[0].auth).toBe("Bearer tok");
    expect(decodeURIComponent(calls[0].url)).toContain("query=update_id:[u1,u2]");
    expect(calls[0].url).toContain("field=count_unique%28user%29");
    await expect(fetchHealthRows(["u"], {}, fetchImpl)).rejects.toThrow(/SENTRY_OPS_TOKEN/);
  });
});

describe("time rule (R34): 24 h with 0 crash or rollback reports", () => {
  it("promotes a quiet update after 24 h even with few installs", () => {
    const h = evaluateHealth(rows(1), {}, { ageHours: 25 });
    expect(h.verdict).toBe("healthy");
    expect(h.reasons[0]).toMatch(/24 h/);
  });
  it("promotes with no installs at all after 24 h", () => {
    expect(evaluateHealth([], {}, { ageHours: 30 }).verdict).toBe("healthy");
  });
  it("still waits before 24 h", () => {
    const h = evaluateHealth(rows(3), {}, { ageHours: 23.5 });
    expect(h.verdict).toBe("wait");
    expect(h.reasons[0]).toMatch(/out for 23 of 24 h/);
  });
  it("waits when the age is unknown", () => {
    expect(evaluateHealth(rows(3)).verdict).toBe("wait");
  });
  it("does not promote on time when a rollback (failed) was reported", () => {
    expect(evaluateHealth(rows(3, 0, 1), {}, { ageHours: 48 }).verdict).toBe("wait");
  });
  it("holds on a crash however old", () => {
    expect(evaluateHealth(rows(3, 1), {}, { ageHours: 48 }).verdict).toBe("halt");
  });
  it("20 installs with good rates still wins before 24 h", () => {
    expect(evaluateHealth(rows(20), {}, { ageHours: 2 }).verdict).toBe("healthy");
  });
  it("reads the age from the earliest update in a group", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    expect(ageHoursFrom([{ createdAt: "2026-10-26T12:00:00Z" }, { createdAt: "2026-10-26T18:00:00Z" }], now)).toBe(24);
    expect(ageHoursFrom([{}], now)).toBeNull();
  });
});
