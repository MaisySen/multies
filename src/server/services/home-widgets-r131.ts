/**
 * R131: Home widgets layouts. One row per person per workspace, plus one workspace default row (user_id '').
 * Reading Home is one query for both rows. Only owners and admins write the workspace default.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { homeLayouts } from "../db/schema";
import { forbidden } from "../lib/errors";
import { builtinLayout, HomeLayout, normalizeLayout, WIDGET_IDS, type HomeWidgetsView, type WidgetId } from "@/shared/home-widgets-r131";

const WORKSPACE = "";
type Actor = Pick<AuthContext, "orgId" | "userId" | "role">;

const isManager = (a: Actor) => a.role === "owner" || a.role === "admin";

/** Widgets this workspace can show: social and feeds only where those areas are on; the rest read the person's own data. */
export function availableWidgets(deps: Pick<Deps, "config">): WidgetId[] {
  return WIDGET_IDS.filter((id) => (id === "social" ? deps.config.socialP2b !== false : id === "feeds" ? deps.config.flows !== false : true));
}

function parse(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function getHomeWidgets(deps: Deps, a: Actor): Promise<HomeWidgetsView> {
  const rows = await deps.db.select({ userId: homeLayouts.userId, layout: homeLayouts.layout }).from(homeLayouts)
    .where(and(eq(homeLayouts.orgId, a.orgId), inArray(homeLayouts.userId, [a.userId, WORKSPACE]))).all();
  const mine = rows.find((r) => r.userId === a.userId && a.userId !== WORKSPACE);
  const ws = rows.find((r) => r.userId === WORKSPACE);
  const available = availableWidgets(deps);
  const src = mine ? "mine" : ws ? "workspace" : "builtin";
  const raw = mine ? parse(mine.layout) : ws ? parse(ws.layout) : builtinLayout();
  return { layout: normalizeLayout(raw, available), source: src, hasWorkspaceDefault: !!ws, canSetDefault: isManager(a), available };
}

async function put(deps: Deps, orgId: string, userId: string, layout: HomeLayout) {
  const value = JSON.stringify(layout);
  const now = new Date();
  await deps.db.insert(homeLayouts).values({ orgId, userId, layout: value, updatedAt: now })
    .onConflictDoUpdate({ target: [homeLayouts.orgId, homeLayouts.userId], set: { layout: value, updatedAt: now } });
}

export async function saveMyLayout(deps: Deps, a: Actor, layout: HomeLayout): Promise<HomeWidgetsView> {
  await put(deps, a.orgId, a.userId, normalizeLayout(layout, availableWidgets(deps)));
  return getHomeWidgets(deps, a);
}

/** Reset: forget the person's own layout; they see the workspace default (or the built in one) again. */
export async function resetMyLayout(deps: Deps, a: Actor): Promise<HomeWidgetsView> {
  await deps.db.delete(homeLayouts).where(and(eq(homeLayouts.orgId, a.orgId), eq(homeLayouts.userId, a.userId)));
  return getHomeWidgets(deps, a);
}

export async function saveWorkspaceDefault(deps: Deps, a: Actor, layout: HomeLayout): Promise<HomeWidgetsView> {
  if (!isManager(a)) throw forbidden("Only workspace admins can set the default Home.");
  // Quick links are personal: the workspace default carries the arrangement only.
  await put(deps, a.orgId, WORKSPACE, { ...normalizeLayout(layout, WIDGET_IDS), links: [] });
  return getHomeWidgets(deps, a);
}

export async function clearWorkspaceDefault(deps: Deps, a: Actor): Promise<HomeWidgetsView> {
  if (!isManager(a)) throw forbidden("Only workspace admins can set the default Home.");
  await deps.db.delete(homeLayouts).where(and(eq(homeLayouts.orgId, a.orgId), eq(homeLayouts.userId, WORKSPACE)));
  return getHomeWidgets(deps, a);
}
