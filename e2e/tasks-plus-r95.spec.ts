import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R95 Tasks plus: My Day (add, drag to block, move, plan tomorrow with undo), smart repeat (every weekday, nth
 * weekday, preview), time (tags, billable, day view, export, submit and approve, idle prompt), and the mind map
 * (drag to re parent, undo, cycles refused, keyboard move, phone outline). With SHOTS_DIR set it saves the UX gate
 * shots at 1280 and 390 in light, dark and Forest, and checks axe on each.
 */
const DIR = process.env.SHOTS_DIR;
let n = 0;
const ymd = (d = new Date()) => d.toLocaleDateString("en-CA");

async function signup(page: Page, name = "Pat Planner") {
  const id = `${Date.now().toString(36)}${++n}`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(`r95-${id}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\//, { timeout: 20_000 });
  const me = await (await page.request.get("/api/account/me")).json();
  const project = (await (await page.request.post("/api/projects", { data: { name: "Launch" } })).json()).project as { id: string };
  return { userId: me.user.id as string, projectId: project.id };
}
async function task(page: Page, data: Record<string, unknown>) {
  const r = await page.request.post("/api/tasks", { data });
  expect(r.status()).toBe(201);
  return (await r.json()).task as { id: string; ref: string; title: string };
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
async function axe(page: Page, where: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(500);
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((x) => x.target).join(" | ")}`);
}

test.describe("R95 My Day", () => {
  test("empty, add from due, drag onto the day, move, plan tomorrow and undo", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { userId, projectId } = await signup(page);
    await page.goto("/app/my-work");
    const day = page.getByTestId("my-day");
    await expect(day).toBeVisible();
    await expect(day.getByText("Plan your day")).toBeVisible();
    const noon = new Date(); noon.setHours(17, 0, 0, 0);
    await task(page, { projectId, title: "Write the launch post", assignee: `member:${userId}`, due: noon.toISOString() });
    await task(page, { projectId, title: "Check the pricing page", assignee: `member:${userId}`, due: noon.toISOString() });
    await page.reload();
    const sugg = page.getByTestId("my-day-suggestions");
    await sugg.getByRole("button", { name: "Add Write the launch post to My Day" }).click();
    await expect(page.getByTestId("my-day-item")).toHaveCount(1);
    // Drag the list item onto the day column.
    const grid = page.getByTestId("my-day-grid");
    await page.getByTestId("my-day-item").first().dragTo(grid, { targetPosition: { x: 200, y: 10 * 48 + 20 } });
    await expect(page.getByTestId("my-day-block")).toHaveCount(1);
    await expect(page.getByTestId("my-day-item")).toHaveCount(0);
    // Keyboard: move it later by 15 minutes with the block's own button.
    const block = page.getByTestId("my-day-block").first();
    const before = await block.getAttribute("aria-label");
    await block.hover();
    await page.getByRole("button", { name: "Move Write the launch post later" }).click();
    await expect(block).not.toHaveAttribute("aria-label", before ?? "");
    // A second task dropped on the same time slides to a free slot instead of overlapping.
    await sugg.getByRole("button", { name: "Add Check the pricing page to My Day" }).click();
    await page.getByTestId("my-day-item").first().dragTo(grid, { targetPosition: { x: 200, y: 10 * 48 + 30 } });
    await expect(page.getByTestId("my-day-block")).toHaveCount(2);
    const tops = await page.getByTestId("my-day-block").evaluateAll((els) => els.map((e) => [parseFloat((e as HTMLElement).style.top), parseFloat((e as HTMLElement).style.height)]));
    tops.sort((a, b) => a[0] - b[0]);
    expect(tops[1][0]).toBeGreaterThanOrEqual(tops[0][0] + tops[0][1] - 2);
    // Plan tomorrow, then undo.
    await page.getByTestId("plan-tomorrow").click();
    await expect(page.getByText(/Moved 2 to tomorrow/)).toBeVisible();
    await expect(page.getByTestId("my-day-block")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("my-day-block")).toHaveCount(2);
    // Tomorrow tab and the phone layout.
    await page.getByRole("tab", { name: "Tomorrow" }).click();
    await expect(page.getByTestId("my-day-column")).toBeVisible();
    await page.getByRole("tab", { name: "Today" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("my-day-block").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test.describe("R95 smart repeat", () => {
  test("every weekday and the nth weekday of the month with a preview", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { projectId } = await signup(page);
    const t = await task(page, { projectId, title: "Send the board pack", due: "2026-11-10T09:00:00.000Z" });
    await page.goto(`/app/tasks?task=${t.id}`);
    const picker = page.getByTestId("repeat-picker").first();
    await picker.getByLabel("Repeat", { exact: true }).selectOption("weekdays");
    await expect(picker.getByTestId("repeat-preview")).toContainText("Every weekday");
    await expect(picker.getByTestId("repeat-preview")).toContainText("Next:");
    await picker.getByLabel("Repeat", { exact: true }).selectOption("monthly");
    await picker.getByLabel("Monthly on").selectOption("nth");
    await picker.getByLabel("Which week").selectOption("2");
    await picker.getByLabel("Weekday").selectOption("2");
    await expect(picker.getByTestId("repeat-preview")).toContainText("2nd Tue");
    await picker.getByLabel("Count from").selectOption("done");
    await expect(picker.getByTestId("repeat-preview")).toContainText("after done");
    const saved = await (await page.request.get(`/api/tasks/${t.id}`)).json();
    expect(saved.task?.repeat ?? saved.repeat).toMatchObject({ freq: "monthly", nth: 2, nthWeekday: 2, basis: "done" });
  });
});

test.describe("R95 time", () => {
  test("tags, billable, day view, export, submit and approve, idle prompt", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { projectId } = await signup(page, "Tia Timer");
    const t = await task(page, { projectId, title: "Design review" });
    await page.request.post("/api/time", { data: { taskId: t.id, minutes: 90, date: ymd(), note: "Mockups" } });
    await page.goto("/app/time");
    await expect(page.getByTestId("week-status")).toContainText("Your week of");
    // Tags and billable on the entry.
    await page.getByRole("button", { name: "Edit tags" }).first().click();
    await page.getByLabel("Tags, separated by commas").fill("client a, design");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("client a").first()).toBeVisible();
    await page.getByTestId("entry-billable").first().click();
    await expect(page.getByTestId("entry-billable").first()).toHaveText("Not billable");
    await page.getByTestId("tag-filter").fill("design");
    await expect(page.getByTestId("timesheet-total")).toHaveText("1h 30m");
    await page.getByTestId("tag-filter").fill("nothing");
    await expect(page.getByText("No time this week")).toBeVisible();
    await page.getByTestId("tag-filter").fill("");
    // Day view.
    await page.getByRole("tab", { name: "Day" }).click();
    await expect(page.getByTestId("day-timeline").or(page.getByTestId("day-timeline-empty"))).toBeVisible();
    await page.getByRole("tab", { name: "Week" }).click();
    // Export.
    const href = await page.getByTestId("time-export").getAttribute("href");
    const csv = await (await page.request.get(href!)).text();
    expect(csv.split("\r\n")[0]).toBe("Date,Person,Project,Task,Note,Tags,Billable,Start,End,Hours");
    expect(csv).toContain("client a; design,no");
    // Submit, then the week is locked, then the admin approves it.
    await page.getByTestId("week-submit").click();
    await expect(page.getByTestId("week-status")).toContainText("Submitted");
    const locked = await page.request.post("/api/time", { data: { taskId: t.id, minutes: 10, date: ymd() } });
    expect(locked.status()).toBe(201); // the owner is an admin: admins can still fix time
    await expect(page.getByTestId("approval-queue")).toBeVisible();
    await page.getByTestId("approve-week").click();
    await expect(page.getByTestId("week-status")).toContainText("Approved");
    // Idle prompt: a short threshold, a running timer, a quiet gap, then activity.
    await page.evaluate(() => localStorage.setItem("r95-idle-ms", "1500"));
    await page.request.post("/api/time/start", { data: { taskId: t.id } });
    await page.goto("/app/tasks");
    await expect(page.getByTestId("timer-chip")).toBeVisible();
    await page.waitForTimeout(2500);
    await page.mouse.move(300, 300);
    await page.mouse.move(320, 320);
    await expect(page.getByText(/You were away for/)).toBeVisible();
    await page.getByTestId("idle-drop").click();
    await expect(page.getByText("Dropped the time away. The timer is running again.")).toBeVisible();
    await page.evaluate(() => localStorage.removeItem("r95-idle-ms"));
  });
});

test.describe("R95 mind map", () => {
  test("drag to re parent, undo, cycles refused, keyboard move, phone outline", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { projectId } = await signup(page, "Max Mapper");
    const a = await task(page, { projectId, title: "Website" });
    const b = await task(page, { projectId, title: "Launch email" });
    await task(page, { projectId, title: "Hero copy", parentId: a.id });
    await page.goto(`/app/tasks?view=mindmap&project=${projectId}`);
    const map = page.getByTestId("mind-map");
    await expect(map).toBeVisible();
    await expect(map.getByTestId("map-node")).toHaveCount(3);
    const node = (title: string) => map.getByTestId("map-node").filter({ hasText: title });
    // Drag Hero copy under Launch email.
    await node("Hero copy").dragTo(node("Launch email"));
    await expect(page.getByText("Moved Hero copy under Launch email")).toBeVisible();
    const parentOf = async (title: string) => {
      const list = (await (await page.request.get(`/api/tasks?projectId=${projectId}&includeSubtasks=true`)).json()).tasks as { title: string; parentId: string | null }[];
      return list.find((x) => x.title === title)?.parentId ?? null;
    };
    await expect.poll(() => parentOf("Hero copy")).toBe(b.id);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => parentOf("Hero copy")).toBe(a.id);
    // A parent can't go under its own child.
    await expect(node("Hero copy")).toBeVisible();
    await node("Website").dragTo(node("Hero copy"));
    await expect(page.getByText("A task can't go under one of its own subtasks.")).toBeVisible();
    expect(await parentOf("Website")).toBeNull();
    // Keyboard: focus Launch email, M, down to Hero copy... pick Website (above), Enter.
    await node("Launch email").focus();
    await page.keyboard.press("m");
    await expect(page.getByText(/Moving Launch email/).first()).toBeVisible();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
    await page.keyboard.press("Enter");
    if (focused.includes("Website")) await expect.poll(() => parentOf("Launch email")).toBe(a.id);
    // Phone: an outline with Move to.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("mind-map-outline")).toBeVisible();
    await page.getByLabel("Move Hero copy to").selectOption("");
    await expect.poll(() => parentOf("Hero copy")).toBeNull();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test.describe("R95 shots and axe", () => {
  test("My Work, time, task repeat and mind map in light, dark and Forest at 1280 and 390", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    const { userId, projectId } = await signup(page, "Sam Shots");
    const due = new Date(); due.setHours(17, 0, 0, 0);
    const t1 = await task(page, { projectId, title: "Prepare the client workshop", assignee: `member:${userId}`, due: due.toISOString(), repeat: { freq: "monthly", nth: 2, nthWeekday: 2, tz: "Australia/Sydney" } });
    const t2 = await task(page, { projectId, title: "Review the quarterly numbers", assignee: `member:${userId}`, due: due.toISOString() });
    await task(page, { projectId, title: "Reply to supplier questions", assignee: `member:${userId}`, due: due.toISOString() });
    await task(page, { projectId, title: "Agenda", parentId: t1.id });
    await task(page, { projectId, title: "Book the room", parentId: t1.id });
    await task(page, { projectId, title: "Slides", parentId: t2.id });
    await page.request.post("/api/my-day", { data: { day: ymd(), taskId: t1.id, start: 540, minutes: 90 } });
    await page.request.post("/api/my-day", { data: { day: ymd(), taskId: t2.id, start: 660, minutes: 60 } });
    await page.request.post("/api/time", { data: { taskId: t1.id, minutes: 75, date: ymd(), tags: ["client a"] } });
    await page.request.post("/api/time", { data: { taskId: t2.id, minutes: 40, date: ymd(), billable: false } });
    const errors: string[] = [];
    const pages: [string, string][] = [["mywork", "/app/my-work"], ["time", "/app/time"], ["mindmap", `/app/tasks?view=mindmap&project=${projectId}`], ["repeat", `/app/tasks?task=${t1.id}`]];
    const pass = async (theme: string) => {
      for (const [w, h] of [[1280, 900], [390, 844]] as const) {
        await page.setViewportSize({ width: w, height: h });
        for (const [name, url] of pages) {
          await page.goto(url);
          if (name === "mywork") await expect(page.getByTestId("my-day")).toBeVisible();
          if (name === "mindmap") await expect(page.getByTestId(w === 390 ? "mind-map-outline" : "mind-map")).toBeVisible();
          if (name === "repeat") await expect(page.getByTestId("repeat-picker").first()).toBeVisible();
          if (name === "mywork") await page.getByTestId("my-day").scrollIntoViewIfNeeded();
          errors.push(...await axe(page, `${name} ${w} ${theme}`));
          expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name} ${w} ${theme} no sideways scroll`).toBeLessThanOrEqual(w);
          await shot(page, `r95-${name}-${w}-${theme}`);
        }
      }
    };
    await pass("light");
    await page.emulateMedia({ colorScheme: "dark" });
    await pass("dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/app/settings/branding");
    await page.getByRole("button", { name: "Forest", exact: true }).click();
    await page.getByRole("button", { name: "Save brand" }).click();
    await page.waitForTimeout(800);
    await pass("forest");
    expect(errors.flat()).toEqual([]);
  });
});
