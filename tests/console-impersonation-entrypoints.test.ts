/**
 * OPS1 impersonation: every way a session is used without requireAuth.
 * - A source sweep: a new direct resolveAuth / resolveAuthCached / auth.api.getSession caller fails this test unless it
 *   goes through resolveAuthFor (auth/guards.ts) or is one of the reviewed exceptions below.
 * - The doc co-editing socket: view mode joins read only and silent (no edits, no presence as the person); act mode edits.
 * - The live chat socket: receive only for everyone, so both modes may listen.
 * - showError: the "Changes are turned off" toast at most once every 30 seconds, never for background calls.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import { eq } from "drizzle-orm";
import { members } from "@/server/db/schema";
import { clearAuthCache } from "@/server/auth/guards";
import { collabAccess } from "@/server/collab/access";
import { CollabRoom, MESSAGE_AWARENESS, MESSAGE_SYNC } from "@/server/collab/room";
import { chatLiveAccess } from "@/server/realtime/access";
import { makeTestApp } from "./helpers";
import { signUpAs } from "./console-kit";

const toasts = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => { toasts.calls.push(a); }, success: () => undefined } }));

beforeEach(() => clearAuthCache());

const ROOT = join(__dirname, "..");
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * Reviewed callers that read a session without resolveAuthFor, and why each is safe:
 * - auth/guards.ts: defines resolveAuth, resolveAuthCached (used by requireAuth, which runs the impersonation check)
 *   and resolveAuthFor itself.
 * - auth/operator.ts: operatorSession refuses every impersonated session (403 impersonating) except Stop.
 * - auth/mobile-web-link.ts: GET /auth/mobile/web reads the current session only to refuse swapping a browser signed
 *   in as someone else; the code in the link, minted by requireAuth (blocked while impersonated), is the credential.
 */
const REVIEWED = new Set(["src/server/auth/guards.ts", "src/server/auth/operator.ts", "src/server/auth/mobile-web-link.ts"]);
const DIRECT = /\bresolveAuth\s*\(|\bresolveAuthCached\s*\(|\.api\.getSession\s*\(|\bgetSessionFromCtx\s*\(/;

describe("entry point sweep", () => {
  it("no file reads a session directly except through resolveAuthFor or a reviewed exception", () => {
    const offenders: string[] = [];
    for (const dir of ["src/server", "src/entry"]) {
      for (const file of sources(join(ROOT, dir))) {
        const rel = relative(ROOT, file).replace(/\\/g, "/");
        if (REVIEWED.has(rel)) continue;
        const text = readFileSync(file, "utf8");
        text.split("\n").forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (DIRECT.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the socket entry points use resolveAuthFor", () => {
    for (const f of ["src/server/collab/access.ts", "src/server/realtime/access.ts"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).toMatch(/resolveAuthFor\(/);
    }
  });
});

const WS = { upgrade: "websocket", origin: "http://localhost", host: "localhost" };

async function impersonating(mode: "view" | "act") {
  const ctx = await makeTestApp();
  const op = await signUpAs(ctx, `op.${mode}@ops.test`, mode === "act" ? "ops_admin" : "ops_support");
  const target = await signUpAs(ctx, "tara@example.com", null, "Target Co");
  const r = await op.c.post("/api/console/impersonation", { userId: target.id, mode, reason: "Checking the doc editor" });
  if (r.status !== 201) throw new Error(`start failed ${r.status} ${JSON.stringify(r.body)}`);
  const orgId = (await ctx.db.select().from(members).where(eq(members.userId, target.id)).get())!.organizationId;
  return { ctx, op, target, orgId };
}

describe("doc co-editing socket", () => {
  for (const mode of ["view", "act"] as const) {
    it(`${mode} mode: ${mode === "view" ? "read only and silent" : "can edit"}`, async () => {
      const { ctx, op } = await impersonating(mode);
      const docId = await personDoc(ctx);
      const req = new Request(`http://localhost/api/docs/${docId}/collab`, { headers: { ...WS, cookie: op.c.cookie } });
      const access = await collabAccess(ctx.app, ctx.deps, req, docId);
      expect(access).toEqual(mode === "view" ? { ok: true, readOnly: true, silent: true } : { ok: true, readOnly: false });
    }, 60_000);
  }
});

/** Makes a doc as the target person through their own fresh session. */
async function personDoc(ctx: Awaited<ReturnType<typeof makeTestApp>>): Promise<string> {
  const { Client } = await import("./helpers");
  const c = new Client(ctx.app);
  const r = await c.login("tara@example.com");
  if (r.status !== 200) throw new Error(`login ${r.status}`);
  const d = await c.post("/api/docs", { title: "Plan" });
  const id = d.body?.doc?.id ?? d.body?.id;
  if (!id) throw new Error(`doc ${d.status} ${JSON.stringify(d.body)}`);
  return id;
}

describe("collab room honours silent and read only connections", () => {
  function awarenessMessage(state: Record<string, unknown>) {
    const doc = new Y.Doc();
    const aw = new awarenessProtocol.Awareness(doc);
    clearInterval((aw as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
    aw.setLocalState(state);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(aw, [doc.clientID]));
    return { msg: encoding.toUint8Array(enc), id: doc.clientID };
  }
  function updateMessage(text: string) {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, text);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
    return encoding.toUint8Array(enc);
  }
  it("a silent read only connection changes neither the doc nor the presence others see", () => {
    const room = new CollabRoom();
    const silent = { readOnly: true, silent: true, send: () => undefined };
    const normal = { send: () => undefined };
    room.join(silent);
    room.join(normal);
    const a = awarenessMessage({ user: { name: "Tara (viewed by support)" } });
    room.receive(silent, a.msg);
    expect(room.awareness.getStates().has(a.id)).toBe(false);
    room.receive(silent, updateMessage("support typed this"));
    expect(room.doc.getText("t").toString()).toBe("");
    const b = awarenessMessage({ user: { name: "Ben" } });
    room.receive(normal, b.msg);
    expect(room.awareness.getStates().has(b.id)).toBe(true);
    room.receive(normal, updateMessage("Ben typed this"));
    expect(room.doc.getText("t").toString()).toBe("Ben typed this");
  });
});

describe("live chat socket", () => {
  it("both modes may listen (the socket never writes; typing is an HTTP write view mode refuses)", async () => {
    for (const mode of ["view", "act"] as const) {
      const { ctx, op, target, orgId } = await impersonating(mode);
      const access = await chatLiveAccess(ctx.deps, new Request("http://localhost/api/chat/live", { headers: { ...WS, cookie: op.c.cookie } }));
      expect(access, mode).toEqual({ ok: true, userId: target.id, orgId });
    }
  }, 60_000);
});

describe("the view mode toast", () => {
  it("shows at most once every 30 seconds and never for background calls", async () => {
    const { ApiError } = await import("@/web/lib/api");
    const { showError, IMPERSONATION_TOAST_MS } = await import("@/web/lib/show-error");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
      const blocked = () => new ApiError(403, "impersonation_blocked", "You are viewing as this person. Changes are turned off.");
      const bg = blocked(); bg.background = true;
      showError(bg);
      expect(toasts.calls).toHaveLength(0);
      showError(blocked());
      showError(blocked());
      showError(blocked());
      expect(toasts.calls).toHaveLength(1);
      expect(toasts.calls[0][0]).toBe("You are viewing as this person. Changes are turned off.");
      vi.setSystemTime(Date.now() + IMPERSONATION_TOAST_MS + 1);
      showError(blocked());
      expect(toasts.calls).toHaveLength(2);
      // Other errors are untouched.
      showError(new ApiError(400, "bad_request", "Something else"));
      expect(toasts.calls).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  });
});
