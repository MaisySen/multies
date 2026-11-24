import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

// The v1 app is built on the first /api/v1 request (src/server/app.ts) to keep a new Worker
// isolate's first request under the Free plan's 10 ms CPU limit. It must behave exactly as
// when it was mounted directly.
describe("lazily built public API", () => {
  it("keeps the JSON errors, the request id and the OpenAPI document", async () => {
    const { app } = await makeTestApp();
    const c = new Client(app);
    expect((await c.get("/api/health")).status).toBe(200);
    const doc = await c.get("/api/v1/openapi.json");
    expect(doc.status).toBe(200);
    expect(doc.body.servers[0].url).toMatch(/\/api\/v1$/);
    expect(Object.keys(doc.body.paths).length).toBeGreaterThan(50);
    const unauth = await app.request("/api/v1/tasks", { headers: { host: "localhost" } });
    expect(unauth.status).toBe(401);
    expect((await unauth.json()).error.code).toBeTruthy();
    expect(unauth.headers.get("x-request-id")).toBeTruthy();
    const missing = await app.request("/api/v1/no-such-thing", { headers: { host: "localhost", authorization: "Bearer mm_live_nope" } });
    expect([401, 404]).toContain(missing.status);
    expect((await missing.json()).error).toBeTruthy();
  });

  it("serves an API key call end to end", async () => {
    const { app } = await makeTestApp();
    const c = new Client(app);
    await c.signup("dev@acme.io");
    // AIS1: a key's task waits in Triage when the project uses it (new projects do); this project has it off and the
    // call names it (Round 2: a key's task that names no project always waits).
    const projectId = (await c.post("/api/projects", { name: "Work", triage: false })).body.project.id as string;
    const key = (await c.post("/api/developer/keys", { name: "QA", scopes: ["read", "write"] })).body;
    const token = key.key ?? key.token ?? key.secret;
    expect(typeof token).toBe("string");
    const res = await app.request("/api/v1/tasks", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "From the API", projectId }) });
    expect(res.status).toBe(201);
    const list = await app.request("/api/v1/tasks", { headers: { host: "localhost", authorization: `Bearer ${token}` } });
    expect(JSON.stringify(await list.json())).toContain("From the API");
    // GET /api/v1/docs is the docs list for a key, not the API reference page (dogfood finding F1).
    const docs = await app.request("/api/v1/docs", { headers: { host: "localhost", authorization: `Bearer ${token}`, accept: "text/html,application/json" } });
    expect(docs.status).toBe(200);
    expect(Array.isArray((await docs.json()).docs)).toBe(true);
  });
});
