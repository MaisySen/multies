/** R131: Home widgets layout (flag HOME_WIDGETS_R131; mounted only when on). Session routes: guests and portal users never reach them. */
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HomeLayout } from "@/shared/home-widgets-r131";
import { clearWorkspaceDefault, getHomeWidgets, resetMyLayout, saveMyLayout, saveWorkspaceDefault } from "../services/home-widgets-r131";

export function homeWidgetsRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await getHomeWidgets(c.var.deps, c.var.auth)))
    .put("/", async (c) => c.json(await saveMyLayout(c.var.deps, c.var.auth, await parseBody(c, HomeLayout))))
    .delete("/", async (c) => c.json(await resetMyLayout(c.var.deps, c.var.auth)))
    .put("/default", async (c) => c.json(await saveWorkspaceDefault(c.var.deps, c.var.auth, await parseBody(c, HomeLayout))))
    .delete("/default", async (c) => c.json(await clearWorkspaceDefault(c.var.deps, c.var.auth)));
}
