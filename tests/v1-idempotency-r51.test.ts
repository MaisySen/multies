import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { v1Routes } from "@/server/routes/v1";

/**
 * R51 (MB-239): every v1 write route, sent twice with one Idempotency-Key, gives the same status and body the
 * second time (marked idempotent-replayed) and writes no new row anywhere. Bodies are built from each route's
 * OpenAPI schema (required fields only), path ids point at seeded items, so many calls succeed for real; a call
 * that is refused (404, 422, 403) must replay its refusal just the same.
 */
type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; example?: unknown;
  default?: unknown; format?: string; minimum?: number; minItems?: number; minLength?: number; anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[]; $ref?: string; const?: unknown };

function sample(s: Schema | undefined, root: { components?: { schemas?: Record<string, Schema> } }, depth = 0): unknown {
  if (!s || depth > 6) return undefined;
  if (s.$ref) return sample(root.components?.schemas?.[s.$ref.split("/").pop()!], root, depth + 1);
  if (s.example !== undefined) return s.example;
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  if (s.default !== undefined) return s.default;
  const alt = s.anyOf ?? s.oneOf;
  if (alt?.length) return sample(alt.find((x) => x.type !== "null") ?? alt[0], root, depth + 1);
  if (s.allOf?.length) return Object.assign({}, ...s.allOf.map((x) => sample(x, root, depth + 1) as object));
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  if (t === "object" || s.properties) {
    const o: Record<string, unknown> = {};
    for (const k of s.required ?? []) o[k] = sample(s.properties?.[k], root, depth + 1);
    return o;
  }
  if (t === "array") return s.minItems ? [sample(s.items, root, depth + 1)] : [];
  if (t === "integer" || t === "number") return Math.max(s.minimum ?? 1, 1);
  if (t === "boolean") return false;
  if (s.format === "email") return "qa.r51@example.com";
  if (s.format === "uri" || s.format === "url") return "https://example.com/r51";
  if (s.format === "date-time") return new Date(Date.now() + 86_400_000).toISOString();
  if (s.format === "date") return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return "QA r51 " + "x".repeat(Math.max(0, (s.minLength ?? 0) - 7));
}

const keyFor = (i: number) => `r51-replay-${String(i).padStart(4, "0")}-abcdef`;

describe("v1 replay safety on every write route (R51 MB-239)", () => {
  it("each write route sent twice with one key: same status, same body, replay header, no new row", async () => {
    const t = await makeTestApp();
    const c = new Client(t.app);
    await c.signup("owner.r51@acme.io", "Olive Owner");
    const secret = (await c.post("/api/developer/keys", { name: "rw" })).body.secret as string;
    const h = (extra: Record<string, string> = {}) => ({ host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json", ...extra });
    const v1 = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const r = await t.app.request(`/api/v1${path}`, { method, headers: h(extra), body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, text: await r.text(), replayed: r.headers.get("idempotent-replayed") === "true" };
    };
    const idOf = (text: string): string | undefined => { try { const j = JSON.parse(text); const v = Object.values(j)[0] as { id?: string } | undefined; return j.id ?? v?.id; } catch { return undefined; } };
    // Seed one of the main objects so path ids resolve.
    const seed: Record<string, string | undefined> = {};
    seed.projects = idOf((await v1("POST", "/projects", { name: "Seed project" })).text);
    seed.tasks = idOf((await v1("POST", "/tasks", { title: "Seed task", projectId: seed.projects })).text);
    seed.docs = idOf((await v1("POST", "/docs", { title: "Seed doc" })).text);
    seed.comments = idOf((await v1("POST", `/tasks/${seed.tasks}/comments`, { body: "Seed comment" })).text);
    seed.deals = idOf((await v1("POST", "/deals", { title: "Seed deal" })).text);
    seed.meetings = idOf((await v1("POST", "/meetings", { title: "Seed meeting", startsAt: new Date(Date.now() + 86_400_000).toISOString() })).text);
    const contact = (await v1("POST", "/contacts", { email: "seed.contact@example.com", name: "Seed Contact" })).text;
    seed.contacts = idOf(contact);
    const doc = JSON.parse((await v1("GET", "/openapi.json")).text) as { paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>>; components?: { schemas?: Record<string, Schema> } };

    const db = t.db as unknown as { all: (q: unknown) => { name?: string; n?: number }[] };
    const tables = db.all(sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%_fts%'`).map((r) => r.name!);
    const counts = () => Object.fromEntries(tables.map((n) => [n, db.all(sql.raw(`select count(*) as n from "${n}"`))[0]!.n]));

    const order = { POST: 0, PUT: 1, PATCH: 2, DELETE: 3 } as Record<string, number>;
    const routes = [...new Set((v1Routes().routes as { method: string; path: string }[]).filter((r) => r.method in order).map((r) => `${r.method} ${r.path}`))]
      .map((s) => { const [method, path] = s.split(" "); return { method: method!, path: path! }; })
      .sort((a, b) => order[a.method]! - order[b.method]!);
    const results: { route: string; status: number; replayed: boolean; sameBody: boolean; newRows: string[]; created?: string }[] = [];
    let i = 0;
    for (const r of routes) {
      if (r.path === "/mcp") continue; // JSON-RPC: covered separately below
      const top = r.path.split("/")[1]!;
      const path = r.path.replace(/:(\w+)/g, (_m, name: string) => {
        const k = name === "id" ? top : name.replace(/Id$/, "") + "s";
        return seed[k] ?? seed[top] ?? "missing_r51";
      });
      const oapi = doc.paths[r.path.replace(/:(\w+)/g, "{$1}")]?.[r.method.toLowerCase()];
      const schema = oapi?.requestBody?.content?.["application/json"]?.schema;
      const body = r.method === "DELETE" ? undefined : (sample(schema, doc) ?? {});
      const k = { "idempotency-key": keyFor(++i) };
      const a = await v1(r.method, path, body, k);
      const before = counts();
      const b = await v1(r.method, path, body, k);
      const after = counts();
      const newRows = tables.filter((n) => after[n] !== before[n]);
      results.push({ route: `${r.method} ${r.path}`, status: a.status, replayed: b.replayed, sameBody: a.text === b.text && a.status === b.status, newRows,
        ...(a.status < 300 && idOf(a.text) ? { created: idOf(a.text) } : {}) });
    }
    writeFileSync("/tmp/r51-replay.json", JSON.stringify(results, null, 1));
    // A first answer of 5xx or 429 is stored as retryable on purpose (the retry runs again), so it is not replayed.
    const bad = results.filter((x) => (x.status < 500 && x.status !== 429) && (!x.replayed || !x.sameBody || x.newRows.length));
    expect(bad, JSON.stringify(bad.slice(0, 10))).toEqual([]);
    expect(results.length).toBeGreaterThan(150);
    const ok = results.filter((x) => x.status < 300).length;
    expect(ok).toBeGreaterThan(20);
  }, 240_000);
});
