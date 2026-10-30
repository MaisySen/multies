import { test, expect, type Page } from "@playwright/test";

/**
 * C1 (chat channels, phase 1) end to end on the local test channel: an admin turns chat on, connects the test
 * channel, a test customer writes in, the chat shows in the shared inbox with its channel chip, gets assigned and a
 * reply, then the reply window closes and the template sheet takes over; finally a task is made from a message.
 */
let visitor = 0;
const ip = () => `10.152.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

for (const [label, w, h] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
  test(`chat channels on the test channel: connect, receive, assign, reply, closed window template, task (${label})`, async ({ page, context, baseURL }) => {
    test.setTimeout(90_000);
    if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
    await page.setViewportSize({ width: w, height: h });
    const headers = { origin: new URL(baseURL!).origin };
    await demo(page);

    // Settings, Channels: switch on, connect the test channel.
    await page.goto("/app/settings/channels");
    const sw = page.getByRole("switch", { name: "Chat channels in the shared inbox" });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("tile-messenger").getByText("Coming soon")).toBeVisible();
    await page.getByRole("button", { name: "Connect test channel" }).click();
    await expect(page.getByTestId("channel-row").first()).toBeVisible();
    await expect(page.getByTestId("channels-usage")).toContainText("Today:");

    // A test customer writes in.
    const status = await (await page.request.get("/api/channels/status", { headers })).json() as { channels: { id: string; status: string }[] };
    const channelId = status.channels.find((c) => c.status === "active")!.id;
    const inbound = await page.request.post("/api/channels/mock/inbound", { data: { channelId, from: "61400111222", name: "Priya Shah", text: "Is the blue jacket in stock in medium?" }, headers });
    expect(inbound.status()).toBe(200);

    // The chat is in the shared inbox with its chip; open it.
    await page.goto("/app/inbox");
    const row = page.getByTestId("chat-row").filter({ hasText: "Priya Shah" });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("channel-chip")).toHaveAttribute("data-provider", "mock");
    await row.click();
    await expect(page).toHaveURL(/conv=/);
    const view = page.getByTestId("chat-view");
    await expect(view.getByTestId("chat-contact")).toHaveText("Priya Shah");
    await expect(view.getByTestId("window-pill")).toContainText("Reply window closes in");
    await expect(view.getByTestId("chat-bubble").filter({ hasText: "blue jacket" })).toHaveAttribute("data-direction", "in");

    // Assign to me.
    await view.getByTestId("chat-assign").getByRole("button", { name: "Assign", exact: true }).click();
    await page.getByRole("menuitem", { name: "Assign to me" }).click();
    await expect(view.getByTestId("chat-assign").getByRole("button", { name: /^Assigned to / })).toBeVisible();

    // Reply: Enter sends, the bubble lands as sent.
    const reply = view.getByRole("textbox", { name: "Reply" });
    await reply.fill("Yes, we have it in medium.");
    await reply.press("Enter");
    const out = view.getByTestId("chat-bubble").filter({ hasText: "Yes, we have it in medium." });
    await expect(out).toHaveAttribute("data-direction", "out");
    await expect(out).toHaveAttribute("data-delivery", /sent|delivered|read/);
    await expect(reply).toHaveValue("");

    // Age the window past 24 hours: the composer gives way to the template sheet.
    const convId = new URL(page.url()).searchParams.get("conv")!;
    expect((await page.request.post("/api/channels/mock/age", { data: { conversationId: convId, hours: 25 }, headers })).status()).toBe(200);
    await page.reload();
    await expect(view.getByTestId("window-closed")).toContainText("more than 24 hours");
    await expect(view.getByTestId("window-pill")).toHaveText("Reply window closed");
    await expect(view.getByRole("textbox", { name: "Reply" })).toHaveCount(0);
    await view.getByRole("button", { name: "Choose a template" }).click();
    const options = page.getByTestId("template-option");
    await expect(options).toHaveCount(2);
    await options.first().click();
    const sheet = page.getByTestId("template-sheet");
    for (const input of await sheet.getByRole("textbox").all()) await input.fill("Priya");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Template sent")).toBeVisible();
    await expect(view.getByTestId("chat-bubble").filter({ hasText: "Template" }).last()).toHaveAttribute("data-direction", "out");

    // Make a task from the customer's message.
    const first = view.getByTestId("chat-bubble").filter({ hasText: "blue jacket" });
    await first.click();
    await first.locator("xpath=..").getByTestId("message-task").click();
    await expect(page.getByText(/created$/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Open" }).first()).toBeVisible();

    // No sideways scroll on the phone.
    if (label === "phone") expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("Settings, Channels shows a calm Coming soon card when the server has no Meta app", async ({ page, context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await demo(page);
  await page.route("**/api/channels/status", (r) => r.fulfill({ json: { available: false, mock: false, enabled: false, canManage: true, channels: [], embeddedSignup: null, usage: { today: 0, softCap: 2000, level: "ok" } } }));
  await page.goto("/app/settings/channels");
  const card = page.getByTestId("channels-coming-soon");
  await expect(card).toContainText("Coming soon");
  await expect(card).toContainText("WhatsApp, Messenger and Instagram messages will land in your shared inbox. We are finishing setup with Meta.");
  await expect(page.getByRole("switch")).toHaveCount(0);
  // The inbox stays mail only: no channel filter.
  await page.goto("/app/inbox");
  await expect(page.getByRole("heading", { name: "Shared inbox" })).toBeVisible();
  await expect(page.getByTestId("channel-filter")).toHaveCount(0);
});
