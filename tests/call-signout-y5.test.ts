/**
 * Wave 3 review Y5: signing out (both paths in the app shell) or switching or making a workspace ends the tab's call.
 * The call session is module state; the sign out only navigated inside the app, so the LiveKit Room kept publishing.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endCallForAccountChange, getCallSession, resetCallSessionForTests, startCallSession } from "@/web/lib/call-session-meet";

afterEach(() => resetCallSessionForTests());

const join = { url: "wss://x", token: "t", room: "r" };

describe("Y5: the call ends when the account or workspace changes", () => {
  it("hangs up the session and reports the person left, once", async () => {
    const disconnect = vi.fn();
    startCallSession({ meetingId: "mtg_1", title: "T", path: "/app/meetings/mtg_1", join, view: "dock", connection: { disconnect } });
    const report = vi.fn(async () => ({}));
    const ended = await endCallForAccountChange(report);
    expect(ended?.meetingId).toBe("mtg_1");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("mtg_1");
    expect(getCallSession()).toBeNull();
    expect(await endCallForAccountChange(report)).toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("a slow or failing report never holds the sign out for long", async () => {
    startCallSession({ meetingId: "mtg_2", title: "T", path: "/p", join, view: "full", connection: { disconnect: () => undefined } });
    const t0 = Date.now();
    await endCallForAccountChange(() => new Promise(() => undefined), 50);
    expect(Date.now() - t0).toBeLessThan(1000);
    startCallSession({ meetingId: "mtg_3", title: "T", path: "/p", join, view: "full", connection: { disconnect: () => undefined } });
    await expect(endCallForAccountChange(async () => { throw new Error("401"); })).resolves.toMatchObject({ meetingId: "mtg_3" });
  });

  it("the app shell ends the call before each sign out, workspace switch and new workspace", () => {
    const src = readFileSync("src/web/layouts/app.tsx", "utf8");
    // The SSO sign out and the account menu's sign out.
    expect(src).toMatch(/leaveCallForAccountChange\(\); await clearOfflineData\(\); try \{ await \(await authClientModule\(\)\)\.authClient\.signOut\(\)/);
    expect(src).toMatch(/const signOut = async \(\) => \{\s*await leaveCallForAccountChange\(\);/);
    expect(src).toMatch(/await leaveCallForAccountChange\(\);[^\n]*\n\s*await api\.post\(`\/account\/workspaces\/\$\{id\}\/switch`\)/);
    expect(src).toMatch(/await leaveCallForAccountChange\(\); await api\.post\("\/account\/workspaces", \{ name \}\)/);
  });
});
