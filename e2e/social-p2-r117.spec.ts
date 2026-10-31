import { test, expect, type Page } from "@playwright/test";

/**
 * R117: Social P2a end to end against the mock networks (COMPOSIO_BASE_URL https://composio.mock): composer v2 (format
 * picker greying, per network text, counters, preview, checks, first comment, campaign, next free slot), the planner
 * (time slots, free slots, list and week views, move with undo), library (caption and image, use in a post), and
 * drafts and approvals (request changes with a note, edit, approve, discard).
 */
let visitor = 0;
const ip = () => `10.187.${test.info().workerIndex % 200}.${++visitor}`;
const PNG = "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";

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

async function connect(page: Page, origin: string, apps: string[]) {
  const ids: Record<string, string> = {};
  for (const app of apps) {
    const r = await (await page.request.post("/api/apps/connect", { data: { app }, headers: { origin } })).json() as { redirectUrl: string };
    const id = new URL(r.redirectUrl).searchParams.get("connected_account_id")!;
    await page.request.post(`/api/apps/accounts/${id}/confirm`, { headers: { origin } });
    ids[app] = id;
  }
  return ids;
}

for (const [label, w, h] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
  test(`social p2: composer, slots, planner, library, approvals (${label})`, async ({ page, context, baseURL }) => {
    test.setTimeout(150_000);
    if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
    await page.setViewportSize({ width: w, height: h });
    await demo(page);
    const origin = new URL(baseURL!).origin;
    const ids = await connect(page, origin, ["linkedin", "facebook", "instagram"]);

    // Planner: no slots yet, add weekday 9:00 and 15:00 slots.
    await page.goto("/app/social");
    await expect(page.getByTestId("planner-v2")).toBeVisible();
    await expect(page.getByTestId("no-slots")).toBeVisible();
    await page.getByTestId("open-slots").click();
    await page.getByTestId("slot-add").click();
    await page.getByTestId("slot-add").click();
    await page.getByTestId("slot-line").nth(1).getByLabel("Time", { exact: true }).fill("15:00");
    for (const d of ["Sat", "Sun"]) await page.getByTestId("slot-line").nth(1).getByRole("button", { name: d }).click();
    await page.getByTestId("slots-save").click();
    await expect(page.getByText("Time slots saved")).toBeVisible();
    await expect(page.getByTestId("no-slots")).toHaveCount(0);
    if (w >= 1024) await expect(page.getByTestId("week-grid").getByTestId("free-slot").first()).toBeVisible();

    // Composer v2: formats grey out networks with the reason.
    await page.goto("/app/social/new");
    await expect(page.getByTestId("composer-v2")).toBeVisible();
    await expect(page.getByTestId("pick-instagram")).toHaveAttribute("data-blocked", "true");
    await expect(page.getByTestId("pick-instagram").getByTestId("pick-why")).toContainText("Instagram needs an image");
    await page.getByTestId("format-picker").getByRole("radio", { name: "Video" }).click();
    await expect(page.getByTestId("pick-linkedin")).toHaveAttribute("data-blocked", "true");
    await expect(page.getByTestId("pick-linkedin").getByTestId("pick-why")).toContainText("videos");
    await page.getByTestId("format-picker").getByRole("radio", { name: "Text" }).click();
    await page.getByTestId("pick-linkedin").getByRole("checkbox").check();
    await page.getByTestId("pick-facebook").getByRole("checkbox").check();
    await page.getByTestId("pick-facebook").getByRole("combobox").selectOption({ label: "Acme Studio" });
    await page.getByTestId("social-text").fill("Spring launch on Friday. See it at https://example.com/spring");
    await expect(page.getByTestId("counter-linkedin")).toContainText("/ 3,000");
    // LinkedIn gets its own text; the tab shows it has one.
    await page.getByTestId("tab-linkedin").click();
    await page.getByTestId("social-text").fill("Our spring range lands Friday. Join us at the launch.");
    await expect(page.getByTestId("use-main-text")).toBeVisible();
    await page.getByTestId("tab-all").click();
    await expect(page.getByTestId("social-text")).toHaveValue(/Spring launch on Friday/);
    // Preview: side panel at 1280, a sheet on phones.
    if (w >= 1280) await expect(page.getByTestId("composer-preview").getByTestId(/preview-(facebook|linkedin)/).first()).toBeVisible();
    else {
      await page.getByTestId("open-preview").click();
      await expect(page.getByRole("dialog").getByTestId(/preview-(facebook|linkedin)/).first()).toBeVisible();
      await page.keyboard.press("Escape");
    }
    // First comment and campaign.
    await page.getByTestId("more-options").click();
    await page.getByTestId("first-comment").fill("Full details on our site.");
    await page.getByTestId("campaign").fill("Spring launch");
    await expect(page.getByTestId("check-row")).toHaveCount(2);
    await expect(page.getByTestId("composer-checks").locator('[data-app="facebook"]')).toHaveAttribute("data-state", "ready");
    // Schedule in the next free slot.
    await page.getByTestId("when-later").click();
    await page.getByTestId("next-slot").click();
    await page.getByTestId("social-submit").click();
    await expect(page.getByText(/Scheduled for/)).toBeVisible();
    await expect(page).toHaveURL(/\/app\/social\/posts$/);
    const sched = page.getByTestId("social-post").filter({ hasText: "Spring launch on Friday" });
    await expect(sched).toHaveAttribute("data-status", "scheduled");
    await expect(sched.getByTestId("post-meta")).toContainText("Spring launch");

    // Planner list view: move it with the dialog, then undo.
    await page.goto("/app/social?view=list");
    await expect(page.getByTestId("list-view")).toContainText("Spring launch on Friday");
    await page.getByRole("button", { name: /^Move post: Spring launch/ }).click();
    const later = new Date(Date.now() + 5 * 86_400_000); later.setHours(11, 30, 0, 0);
    const p2 = (n: number) => String(n).padStart(2, "0");
    await page.getByLabel("New time").fill(`${later.getFullYear()}-${p2(later.getMonth() + 1)}-${p2(later.getDate())}T11:30`);
    await page.getByTestId("move-save").click();
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Moved to" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("Move undone")).toBeVisible();

    // Library: a caption and an image, then use the caption in a post.
    await page.goto("/app/social/library");
    await expect(page.getByTestId("social-library")).toBeVisible();
    await page.getByTestId("library-add-caption").click();
    await page.getByTestId("library-name").fill("Opening hours");
    await page.getByTestId("library-body").fill("Open 9 to 5 on Saturday, closed Sunday.");
    await page.getByTestId("library-save").click();
    await expect(page.getByTestId("library-item").filter({ hasText: "Opening hours" })).toBeVisible();
    await page.getByTestId("library-add-image").click();
    await page.getByTestId("library-file").setInputFiles({ name: "shop.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
    await page.getByTestId("library-save").click();
    await expect(page.getByTestId("library-item").filter({ hasText: "shop" })).toBeVisible();
    await expect(page.getByTestId("library-usage")).toContainText("2 of 200 items");
    await page.getByTestId("library-item").filter({ hasText: "Opening hours" }).getByRole("button", { name: "Use in a post" }).click();
    await expect(page.getByTestId("social-text")).toHaveValue("Open 9 to 5 on Saturday, closed Sunday.");
    // Save it as a draft, then discard it from Posts, Drafts.
    await page.getByTestId("pick-linkedin").getByRole("checkbox").check();
    await page.getByTestId("save-draft").click();
    await expect(page).toHaveURL(/status=drafts/);
    const draft = page.getByTestId("social-post").filter({ hasText: "Open 9 to 5" });
    await expect(draft).toHaveAttribute("data-status", "draft");
    await draft.getByTestId("post-discard").click();
    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("Draft discarded")).toBeVisible();
    await expect(page.getByTestId("social-post").filter({ hasText: "Open 9 to 5" })).toHaveCount(0);

    // Approvals: two posts sent for approval; one gets changes asked, one is approved.
    for (const text of ["Needs a better word please", "Ready to go out"]) {
      const r = await page.request.post("/api/social/posts", { headers: { origin }, data: { text, targets: [{ accountId: ids.linkedin }], runAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), mode: "submit" } });
      expect(r.status()).toBe(201);
    }
    await page.goto("/app/approvals");
    const box = page.getByTestId("social-approvals");
    await expect(box.getByTestId("social-approval")).toHaveCount(2);
    await box.getByTestId("social-approval").filter({ hasText: "Needs a better word" }).getByTestId("approval-changes").click();
    await page.getByTestId("approval-note").fill("Say when the doors open.");
    await page.getByTestId("approval-note-save").click();
    await expect(page.getByText("Changes asked. The author sees your note.")).toBeVisible();
    await box.getByTestId("social-approval").filter({ hasText: "Ready to go out" }).getByTestId("approval-approve").click();
    await expect(page.getByText(/Approved\. It goes out/)).toBeVisible();
    await expect(box.getByTestId("social-approval")).toHaveCount(0);
    await page.goto("/app/social/posts?status=drafts");
    const asked = page.getByTestId("social-post").filter({ hasText: "Needs a better word" });
    await expect(asked.getByTestId("post-review-note")).toContainText("Say when the doors open.");
    await asked.getByTestId("post-edit").click();
    await expect(page.getByTestId("composer-review-note")).toContainText("Say when the doors open.");
    await expect(page.getByTestId("social-text")).toHaveValue("Needs a better word please");
    await page.goto("/app/social/posts?status=scheduled");
    await expect(page.getByTestId("social-post").filter({ hasText: "Ready to go out" })).toHaveAttribute("data-status", "scheduled");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
}
