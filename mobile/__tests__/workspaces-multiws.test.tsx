import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider, useSession } from "@/lib/session";
import { kv } from "@/lib/kv";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => ({}), Stack: { Screen: () => null } }));

// Multiws (27 Oct 2026): one person in several workspaces moves the phone between them from Settings, Workspace.
function res(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: () => null } };
}
const user = { id: "u", email: "owner@shop.com.au", name: "Owner", emailVerified: true, twoFactor: false, platformAdmin: false };
const ORGS = [
  { id: "org_north", name: "North", plan: "free", role: "owner", isDemo: false },
  { id: "org_south", name: "South", plan: "free", role: "admin", isDemo: false },
] as const;

let active = "org_north";
let calls: { path: string; method: string }[] = [];
let switchStatus = 200;

async function signedIn() {
  calls = []; active = "org_north"; switchStatus = 200;
  const store = require("expo-secure-store");
  await store.setItemAsync("mymail.cookies", JSON.stringify({ "__Secure-mymail.session_token": "sess.sig" }));
  await store.setItemAsync("mymail.mode", "live");
  await kv().set("list:inbox", "[]");
  await kv().set("meta:live:overview", "{}");
  global.fetch = jest.fn(async (url: string, init: { method: string }) => {
    const path = url.replace(/^https:\/\/[^/]+/, "");
    calls.push({ path, method: init.method });
    if (path.endsWith("/account/me")) {
      const o = ORGS.find((x) => x.id === active)!;
      return res(200, { user, organization: { id: o.id, name: o.name, plan: o.plan, isDemo: false, role: o.role, timezone: "Australia/Sydney", country: "AU" } });
    }
    if (path.endsWith("/account/workspaces")) return res(200, { workspaces: ORGS });
    const m = path.match(/\/account\/workspaces\/([^/]+)\/switch$/);
    if (m && init.method === "POST") {
      if (switchStatus !== 200) return res(switchStatus, { error: { code: "unavailable", message: "Multies is busy. Try again in a minute." } });
      if (!ORGS.some((o) => o.id === m[1])) return res(404, { error: { code: "not_found", message: "Workspace not found." } });
      active = m[1];
      return res(200, { ok: true, workspace: { id: m[1], name: ORGS.find((o) => o.id === m[1])!.name } });
    }
    return res(404, {});
  }) as unknown as typeof fetch;
}

describe("switching workspace from the phone", () => {
  it("moves the session both ways and forgets the old workspace's saved lists", async () => {
    await signedIn();
    const wrapper = ({ children }: { children: ReactNode }) => <SessionProvider>{children}</SessionProvider>;
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.me?.organization?.id).toBe("org_north"));
    await act(async () => { await result.current.switchWorkspace("org_south"); });
    expect(result.current.me?.organization?.name).toBe("South");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/account/workspaces/org_south/switch")).toBe(true);
    expect(await kv().get("list:inbox")).toBeNull();
    expect(await kv().get("meta:live:overview")).toBeNull();
    await act(async () => { await result.current.switchWorkspace("org_north"); });
    expect(result.current.me?.organization?.name).toBe("North");
    // Already there: no call.
    const before = calls.length;
    await act(async () => { await result.current.switchWorkspace("org_north"); });
    expect(calls.length).toBe(before);
  });

  it("keeps the workspace and its saved lists when the switch fails", async () => {
    await signedIn();
    const wrapper = ({ children }: { children: ReactNode }) => <SessionProvider>{children}</SessionProvider>;
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.me?.organization?.id).toBe("org_north"));
    let err: unknown;
    await act(async () => { try { await result.current.switchWorkspace("org_nope"); } catch (e) { err = e; } });
    expect((err as { status: number }).status).toBe(404);
    expect(result.current.me?.organization?.id).toBe("org_north");
    expect(await kv().get("list:inbox")).toBe("[]");
  });
});

describe("Workspaces screen", () => {
  const Workspaces = () => { const S = require("@/app/workspaces").default; return <S />; };
  const ui = () => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider><Workspaces /></SessionProvider>
    </QueryClientProvider>
  );

  it("lists every workspace, ticks the open one, and opens another on tap", async () => {
    await signedIn();
    await render(ui());
    expect(await screen.findByText("North")).toBeTruthy();
    expect(screen.getByText("South")).toBeTruthy();
    expect(screen.getByText("Your 2 workspaces")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("workspace-org_north").props.accessibilityState.selected).toBe(true));
    await fireEvent.press(screen.getByTestId("workspace-org_south"));
    await waitFor(() => expect(require("expo-router").router.back).toHaveBeenCalled());
    expect(active).toBe("org_south");
  });

  it("says why when the switch fails and stays put", async () => {
    await signedIn();
    switchStatus = 503;
    await render(ui());
    await screen.findByText("South");
    await waitFor(() => expect(screen.getByTestId("workspace-org_north").props.accessibilityState.selected).toBe(true));
    await fireEvent.press(screen.getByTestId("workspace-org_south"));
    expect(await screen.findByTestId("workspace-switch-error")).toBeTruthy();
    expect(active).toBe("org_north");
  });
});
