import { describe, expect, it, vi } from "vitest";
import { filesFor, prefetchWhenIdle, resetPrefetch, type DownloadOnly, type Loader } from "../src/web/lib/prefetch";
import { ROUTE_MODULES, routeChunkMap } from "../src/shared/prerender-shell";
import { LIKELY_NEXT } from "../src/web/lib/prefetch";

const flush = () => new Promise((r) => setTimeout(r, 0));
const idleNow = { requestIdleCallback: (cb: () => void) => { cb(); return 1; }, setTimeout: vi.fn() };

describe("R31 download only prefetch", () => {
  it("with a build map, the likely next pages' files are only downloaded (no module runs)", async () => {
    resetPrefetch();
    const ran: string[] = [];
    const table: [string, Loader][] = [["/app/tasks", async () => { ran.push("tasks"); }], ["/app/mail", async () => { ran.push("mail"); }]];
    const added: string[] = [];
    const dl: DownloadOnly = { map: async () => ({ "/app/tasks": ["assets/tasks-1.js", "assets/shared-2.js"], "/app/mail": ["assets/mail-3.js", "assets/shared-2.js"] }), add: (f) => added.push(f) };
    prefetchWhenIdle(["/app/tasks", "/app/mail"], idleNow, {}, table, dl);
    await flush();
    expect(added).toEqual(["assets/tasks-1.js", "assets/shared-2.js", "assets/mail-3.js"]);
    expect(ran).toEqual([]);
  });

  it("without a map (the dev server) it loads the pages as before", async () => {
    resetPrefetch();
    const ran: string[] = [];
    const table: [string, Loader][] = [["/app/tasks", async () => { ran.push("tasks"); }]];
    prefetchWhenIdle(["/app/tasks"], idleNow, {}, table, { map: async () => null, add: vi.fn() });
    await flush();
    expect(ran).toEqual(["tasks"]);
  });

  it("skips on Save-Data and 2G", async () => {
    const map = vi.fn(async () => ({}));
    prefetchWhenIdle(["/app/tasks"], idleNow, { connection: { saveData: true } }, [], { map, add: vi.fn() });
    prefetchWhenIdle(["/app/tasks"], idleNow, { connection: { effectiveType: "slow-2g" } }, [], { map, add: vi.fn() });
    await flush();
    expect(map).not.toHaveBeenCalled();
  });

  it("the build map follows imports and covers every likely next page", () => {
    const manifest = {
      "src/web/pages/app/work/tasks.tsx": { file: "assets/tasks.js", imports: ["_shared.js"] },
      "_shared.js": { file: "assets/shared.js", imports: ["_shared.js"] },
      "src/web/pages/app/webmail.tsx": { file: "assets/mail.js", imports: ["_shared.js"] },
    };
    const map = routeChunkMap(manifest, ROUTE_MODULES);
    expect(Object.keys(map).sort()).toEqual(["/app/mail", "/app/tasks"]);
    expect(map["/app/tasks"]).toEqual(["assets/tasks.js", "assets/shared.js"]);
    expect([...map["/app/mail"]].sort()).toEqual(["assets/mail.js", "assets/shared.js"]);
    expect(Object.keys(ROUTE_MODULES).sort()).toEqual([...LIKELY_NEXT].sort());
    expect(filesFor(["/x"], {})).toEqual([]);
  });
});
