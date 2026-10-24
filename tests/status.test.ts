import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { resetStatusCache } from "@/server/services/status";

describe("public status", () => {
  beforeEach(() => resetStatusCache());

  it("reports each component without signing in", async () => {
    const ctx = await makeTestApp();
    const res = await ctx.app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("operational");
    expect(body.components.map((c: { id: string }) => c.id)).toEqual(["app", "database", "inbound", "outbound", "queue", "dns", "mail_apps"]);
    expect(body.components.find((c: { id: string }) => c.id === "outbound").state).toBe("not_configured");
    expect(res.headers.get("cache-control")).toContain("max-age=30");
  });

  it("goes down when the mail server stops answering", async () => {
    const ctx = await makeTestApp({ STALWART_URL: "http://mail.internal:8080", STALWART_ADMIN_USER: "prov", STALWART_ADMIN_SECRET: "x".repeat(24), MAIL_CLIENT_HOST: "mail.example.com" }, {
      fetch: (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    const res = await ctx.app.request("/api/status");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.components.find((c: { id: string }) => c.id === "mail_apps").state).toBe("down");
  });

  it("shows SMTP sending as working on a self-hosted install", async () => {
    const ctx = await makeTestApp();
    Object.defineProperty(ctx.deps.outbound, "name", { value: "smtp" });
    resetStatusCache();
    const s = (await new Client(ctx.app).get("/api/status")).body;
    expect(s.components.find((x: { id: string }) => x.id === "outbound")).toMatchObject({ state: "operational" });
  });
});
