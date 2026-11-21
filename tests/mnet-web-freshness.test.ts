import { MnetEnrollPage } from "@/web/pages/mnet-enroll";
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { MnetDevicesPage } from "@/web/pages/mnet-devices";
import { MnetAuthorizePage } from "@/web/pages/mnet-authorize";

function render(client: QueryClient, page: ReturnType<typeof createElement>, url: string) {
  return renderToString(createElement(MemoryRouter, { initialEntries: [url] }, createElement(QueryClientProvider, { client }, page)));
}

describe("Mnet browser reads are new for each mounted page", () => {
  it("does not render another mount's cached device rows before a fresh check", () => {
    const client = new QueryClient();
    client.setQueryData(["mnet-approved"], { devices: [{ id: "old", deviceKey: "old-private-device-key", platform: "linux", workspace: "old-workspace", expiresAt: new Date(Date.now() + 60000).toISOString() }], truncated: false });
    const html = render(client, createElement(MnetDevicesPage), "/mnet/devices");
    expect(html).not.toContain("old-private-device-key");
    expect(html).not.toContain("old-workspace");
    expect(html).toContain("Checking approvals");
    client.clear();
  });
  it("does not render cached authorization identity or workspaces from a previous mount", () => {
    const client = new QueryClient();
    client.setQueryData(["mnet-authorize", "state=old"], { email: "old-person@example.test", request: { deviceKey: "old-key", platform: "linux", redirectUri: "http://127.0.0.1:9999/mnet/callback", state: "old", challenge: "old" }, workspaces: [{ id: "old", name: "old-private-workspace" }], truncated: false });
    const html = render(client, createElement(MnetAuthorizePage), "/mnet/authorize?state=old");
    expect(html).not.toContain("old-person@example.test");
    expect(html).not.toContain("old-private-workspace");
    expect(html).toContain("Checking Multies sign in");
    client.clear();
  });
});

it("does not reuse a cached enrollment person or mapping on a new mount", () => {
 const client = new QueryClient();
 client.setQueryData(["mnet-enroll", "attemptId=old"], { email: "old-private@example.test", workspaces: [{id:"old",name:"Old private network"}] });
 const html = render(client, createElement(MnetEnrollPage), "/mnet/enroll?attemptId=old");
 expect(html).not.toContain("old-private"); expect(html).not.toContain("Old private"); expect(html).toContain("Checking computer joining request"); client.clear();
});

it("does not expose a previous handoff person or mapping from query cache", async()=>{
 const {MnetEnrollHandoffPage}=await import("@/web/pages/mnet-enroll-handoff");
 const client=new QueryClient();client.setQueryData(["mnet-enrollment-v1","attemptId=old"],{email:"old-private-person@example.test",workspaces:[{id:"old",name:"Old private network"}]});
 const html=render(client,createElement(MnetEnrollHandoffPage),"/mnet/enroll-v1?attemptId=old");
 expect(html).not.toContain("old-private-person");expect(html).not.toContain("Old private network");expect(html).toContain("Checking computer joining handoff");client.clear();
});
