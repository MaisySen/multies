import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * C1: an AI agent answers a WhatsApp chat through MCP. With agent auto send off (the default) its reply lands in the
 * chat as a draft; a person sends it with one tap. Runs on the local test channel.
 */
let visitor = 0;
const ip = () => `10.153.${test.info().workerIndex % 200}.${++visitor}`;
const SHOTS = process.env.C1_SHOTS ?? "";

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

/** One JSON-RPC call to the MCP endpoint (the server answers each request on its own; no session needed). */
async function mcp(request: APIRequestContext, key: string, method: string, params: unknown, id: number) {
  const r = await request.post("/api/v1/mcp", {
    headers: { authorization: `Bearer ${key}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    data: { jsonrpc: "2.0", id, method, params },
  });
  const body = await r.text();
  const line = body.trim().startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}";
  return JSON.parse(line) as { result?: { content?: { text: string }[]; isError?: boolean } };
}

for (const [label, w, h] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
  test(`an agent's chat reply waits as a draft and a person sends it (${label})`, async ({ page, context, baseURL }) => {
    test.setTimeout(90_000);
    if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
    await page.setViewportSize({ width: w, height: h });
    const headers = { origin: new URL(baseURL!).origin };
    await demo(page);

    await page.goto("/app/settings/channels");
    await page.getByRole("switch", { name: "Chat channels in the shared inbox" }).click();
    await page.getByRole("button", { name: "Connect test channel" }).click();
    await expect(page.getByTestId("channel-row").first()).toBeVisible();
    const autosend = page.getByRole("switch", { name: "Agents may send chat replies without review" });
    await expect(autosend).toHaveAttribute("aria-checked", "false");
    if (SHOTS) await page.getByTestId("agent-autosend").screenshot({ path: `${SHOTS}/settings-after-channels-agent-autosend-${label}-light.png` });

    const status = await (await page.request.get("/api/channels/status", { headers })).json() as { channels: { id: string; status: string }[] };
    const channelId = status.channels.find((c) => c.status === "active")!.id;
    expect((await page.request.post("/api/channels/mock/inbound", { data: { channelId, from: "61400555666", name: "Noah Kim", text: "Can I change my delivery to Saturday?" }, headers })).status()).toBe(200);
    const conv = (await (await page.request.get("/api/channels/conversations?q=Noah", { headers })).json() as { data: { id: string }[] }).data[0];

    // The agent replies through MCP with a workspace key.
    const key = (await (await page.request.post("/api/developer/keys", { data: { name: "Support agent" }, headers })).json() as { secret: string }).secret;
    await mcp(page.request, key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } }, 1);
    const res = await mcp(page.request, key, "tools/call", { name: "reply_chat", arguments: { conversationId: conv.id, text: "Yes, Saturday works. I have moved it for you." } }, 2);
    expect(JSON.parse(res.result!.content![0].text)).toMatchObject({ draft: true });

    await page.goto(`/app/inbox?conv=${conv.id}`);
    const view = page.getByTestId("chat-view");
    const draft = view.getByTestId("chat-bubble").filter({ hasText: "Saturday works" });
    await expect(draft).toHaveAttribute("data-delivery", "draft");
    await expect(draft.getByTestId("draft-label")).toBeVisible();
    if (SHOTS) {
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: `${SHOTS}/inbox-after-chat-draft-${label}-${scheme}.png` });
      }
      await page.emulateMedia({ colorScheme: "light" });
    }
    await draft.getByTestId("draft-send").click();
    await expect(view.getByTestId("chat-bubble").filter({ hasText: "Saturday works" })).toHaveAttribute("data-delivery", /sent|delivered|read/);
  });
}
