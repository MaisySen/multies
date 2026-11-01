/**
 * R128 Team password vault (flag VAULT_R128): /api/vault. Signed in people only (sessions; project guests, portal users,
 * keys and agents never reach it). Every response is private and never cached; no request body is ever logged.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { toolFeatureOn } from "../services/tools/features";
import {
  assertVaultOpen, changeAccess, changePassphrase, createFolder, deleteFolder, deleteItem, folderAccess, grantAccess, listAudit, listFolders,
  listItems, recordView, renameFolder, resetVault, revokeAccess, rotateFolder, saveItem, setUpVault, unlockVault, vaultPeople, vaultState,
} from "../services/vault-r128";

const body = async (c: Context<AppEnv>) => {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
};

export function vaultRoutes() {
  const unlockLimiter = new RateLimiter(20, 15 * 60_000); // per person, on top of the stored lockout
  const viewLimiter = new RateLimiter(1200, 60 * 60_000); // reveal and copy audit rows per person an hour
  const take = (l: RateLimiter, key: string) => { if (!l.take(key)) throw new HttpError(429, "rate_limited", "Too many tries. Wait a few minutes and try again."); };
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { await assertVaultOpen(c.var.deps, c.var.auth); c.header("Cache-Control", "private, no-store"); await next(); })
    .get("/state", async (c) => c.json(await vaultState(c.var.deps, c.var.auth, toolFeatureOn(c, "secrets"))))
    .post("/account", async (c) => c.json(await setUpVault(c.var.deps, c.var.auth, await body(c)), 201))
    .post("/open", async (c) => { take(unlockLimiter, `${c.var.auth.orgId}:${c.var.auth.userId}`); return c.json(await unlockVault(c.var.deps, c.var.auth, await body(c))); })
    .post("/account/passphrase", async (c) => { take(unlockLimiter, `${c.var.auth.orgId}:${c.var.auth.userId}`); return c.json(await changePassphrase(c.var.deps, c.var.auth, await body(c))); })
    .post("/account/reset", async (c) => c.json(await resetVault(c.var.deps, c.var.auth, await body(c))))
    .get("/people", async (c) => c.json({ people: await vaultPeople(c.var.deps, c.var.auth) }))
    .get("/folders", async (c) => c.json({ folders: await listFolders(c.var.deps, c.var.auth) }))
    .post("/folders", async (c) => c.json(await createFolder(c.var.deps, c.var.auth, await body(c)), 201))
    .patch("/folders/:id", async (c) => c.json(await renameFolder(c.var.deps, c.var.auth, c.req.param("id"), await body(c))))
    .delete("/folders/:id", async (c) => c.json(await deleteFolder(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/folders/:id/access", async (c) => c.json(await folderAccess(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/folders/:id/access", async (c) => c.json(await grantAccess(c.var.deps, c.var.auth, c.req.param("id"), await body(c)), 201))
    .patch("/folders/:id/access/:userId", async (c) => c.json(await changeAccess(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("userId"), await body(c))))
    .delete("/folders/:id/access/:userId", async (c) => c.json(await revokeAccess(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("userId"))))
    .post("/folders/:id/rotate", async (c) => c.json(await rotateFolder(c.var.deps, c.var.auth, c.req.param("id"), await body(c))))
    .get("/folders/:id/items", async (c) => c.json({ items: await listItems(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/folders/:id/items", async (c) => c.json(await saveItem(c.var.deps, c.var.auth, c.req.param("id"), await body(c)), 201))
    .put("/folders/:id/items/:itemId", async (c) => c.json(await saveItem(c.var.deps, c.var.auth, c.req.param("id"), await body(c), c.req.param("itemId"))))
    .delete("/folders/:id/items/:itemId", async (c) => c.json(await deleteItem(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"))))
    .post("/audit", async (c) => { take(viewLimiter, `${c.var.auth.orgId}:${c.var.auth.userId}`); return c.json(await recordView(c.var.deps, c.var.auth, await body(c)), 201); })
    .get("/audit", async (c) => c.json(await listAudit(c.var.deps, c.var.auth, { before: c.req.query("before"), folderId: c.req.query("folder"), userId: c.req.query("user") })));
}
