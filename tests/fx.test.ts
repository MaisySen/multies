import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers";
import { resetFxCache } from "@/server/routes/fx";

describe("local price for display", () => {
  beforeEach(() => resetFxCache());
  const rates = (calls: { n: number }, ok = true) => (async () => {
    calls.n++;
    return ok ? new Response(JSON.stringify({ date: "2026-10-24", rates: { BRL: 3.6, USD: 0.66, NPR: 88.1 } }), { status: 200 }) : new Response("down", { status: 503 });
  }) as unknown as typeof fetch;

  it("turns A$ into the visitor's currency from the edge's country, and keeps the rates", async () => {
    const calls = { n: 0 };
    const ctx = await makeTestApp({}, { fetch: rates(calls) });
    const br = await ctx.app.request("/api/fx", { headers: { "cf-ipcountry": "BR" } });
    expect(await br.json()).toMatchObject({ base: "AUD", country: "BR", currency: "BRL", rate: 3.6, date: "2026-10-24" });
    const np = await ctx.app.request("/api/fx?country=us");
    expect(await np.json()).toMatchObject({ currency: "USD", rate: 0.66 });
    expect(calls.n).toBe(1);
  });

  it("Australia, unknown countries and a failed rate read show A$ alone", async () => {
    const calls = { n: 0 };
    const ctx = await makeTestApp({}, { fetch: rates(calls, false) });
    expect(await (await ctx.app.request("/api/fx", { headers: { "cf-ipcountry": "AU" } })).json()).toMatchObject({ currency: "AUD", rate: 1 });
    expect(await (await ctx.app.request("/api/fx", { headers: { "cf-ipcountry": "XX" } })).json()).toMatchObject({ currency: "AUD", rate: null });
    expect(await (await ctx.app.request("/api/fx?country=BR")).json()).toMatchObject({ currency: "BRL", rate: null });
    expect(calls.n).toBe(0 + 1);
  });
});
