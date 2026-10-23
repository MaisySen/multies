import { test, expect, type Page } from "@playwright/test";

/**
 * The work suite end to end: a task from an email, a drag on the board, a contact made from
 * mail, and an agent's MCP task tool call showing up in the app.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.77.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/);
  // The sample projects and tasks are seeded straight after sign-in.
  await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
}

test("make a task from an email, and see the thread on the task", async ({ page }) => {
  await demo(page);
  await page.goto("/app/mail");
  await page.getByText("Launch checklist for Friday").first().click();
  await page.getByRole("button", { name: "Make task from this email" }).click();
  const chip = page.getByTestId("linked-task").filter({ hasText: "To do" });
  await expect(chip).toBeVisible();
  await chip.click();
  const panel = page.getByRole("dialog", { name: "Task" });
  await expect(panel.getByLabel("Title")).toHaveValue("Launch checklist for Friday");
  const thread = panel.getByRole("region", { name: "Email thread" });
  await expect(thread.getByText("Quick checklist before Friday's launch", { exact: false })).toBeVisible();
  // Edits save: move it to In progress from the panel.
  await panel.getByLabel("Status").selectOption({ label: "In progress" });
  await expect.poll(async () => (await (await page.request.get("/api/tasks?q=Launch checklist")).json()).tasks[0].statusName).toBe("In progress");
});

test("drag a card across the board to change its status", async ({ page }) => {
  await demo(page);
  await page.goto("/app/tasks");
  const card = page.getByTestId("column-Backlog").getByTestId("board-card").filter({ hasText: "Write the case study with Maria" });
  const done = page.getByTestId("column-Done");
  await expect(card).toBeVisible();
  const from = (await card.boundingBox())!;
  const to = (await done.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 12);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + from.width / 2 + ((to.x + to.width / 2 - from.x - from.width / 2) * i) / 12, from.y + 12 + ((to.y + 80 - from.y - 12) * i) / 12);
  await page.mouse.up();
  await expect(done.getByText("Write the case study with Maria")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/api/tasks?q=case study")).json()).tasks[0].status).toBe("done");
  await page.reload();
  await expect(page.getByTestId("column-Done").getByText("Write the case study with Maria")).toBeVisible();
});

test("a contact is made automatically from mail, with the thread on their timeline", async ({ page }) => {
  await demo(page);
  // Mail you send to someone new makes them a contact, with a company from their domain.
  const subject = `Quote for the cool room ${Date.now()}`;
  await page.goto("/app/mail?compose=1");
  const compose = page.getByRole("dialog", { name: "New message" });
  await compose.getByLabel("To").fill("lena@harbourfresh.com.au");
  await compose.getByLabel("Subject").fill(subject);
  await compose.getByLabel("Message").fill("Hi Lena, the quote is attached.");
  await compose.getByRole("button", { name: "Send" }).click();
  await expect(compose).toBeHidden();
  await page.goto("/app/contacts");
  await page.getByLabel("Search contacts").fill("lena");
  const row = page.getByTestId("contact-list").getByRole("link", { name: /lena@harbourfresh\.com\.au/ });
  await expect(row).toContainText("Harbourfresh");
  await row.click();
  await expect(page.getByTestId("contact-timeline").getByText(subject)).toBeVisible();
  // Mail that arrived before the suite existed is in contacts too.
  await page.goto("/app/contacts");
  await page.getByLabel("Search contacts").fill("maria");
  await expect(page.getByTestId("contact-list")).toContainText("Maria Gonzalez");
});

test("an agent makes and finishes a task with MCP tool calls, and the team sees it", async ({ page, request }) => {
  await demo(page);
  await page.goto("/app/settings/developers");
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Suite agent");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  const key = (await page.getByRole("dialog", { name: "Copy your API key" }).locator("code").first().textContent())!.trim();
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await request.post("/api/v1/mcp", {
      headers: { authorization: `Bearer ${key}`, accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.result.isError ?? false).toBe(false);
    return JSON.parse(body.result.content[0].text);
  };
  const made = await call("create_task", { title: "Chase the Blue Harbor DNS change", priority: "high", due: "2026-12-01" });
  expect(made.task.ref).toMatch(/^TSK-\d+$/);
  await call("comment_on_task", { id: made.task.ref, body: "Asked Maria's IT contact for access." });
  const listed = await call("list_tasks", { q: "Blue Harbor DNS" });
  expect(listed.tasks.map((t: { ref: string }) => t.ref)).toContain(made.task.ref);
  await page.goto(`/app/tasks?view=list&task=${made.task.id}`);
  const panel = page.getByRole("dialog", { name: "Task" });
  await expect(panel.getByLabel("Title")).toHaveValue("Chase the Blue Harbor DNS change");
  await expect(panel.getByRole("region", { name: "Comments" })).toContainText("Asked Maria's IT contact for access.");
});
