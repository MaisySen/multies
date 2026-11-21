import { test, expect, type Page, type Route } from "@playwright/test";
import { mockConsoleMe } from "./support/console-me";

/**
 * OPS1: the console's Announcements page (/console/announcements). The operator and the announcements API are
 * mocked; the server's own rules are covered by tests/console-announcements-routes.test.ts. The empty state, the
 * live preview drawing the real banner, publish and remove each sending a reason, and a support operator who sees
 * the current announcement without the form or the Remove button.
 */
async function signUp(page: Page, who: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who);
  await page.getByLabel("Work email").fill(`e2e-ops1-ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

type Body = Record<string, unknown> & { reason?: string };

function stored(body: Body) {
  return {
    id: "ann_e2e_1", text: body.text, tone: body.tone ?? "info", audience: body.audience ?? "all",
    linkLabel: body.linkLabel ?? null, linkUrl: body.linkUrl ?? null, startsAt: body.startsAt ?? null, endsAt: body.endsAt ?? null,
    dismissible: body.dismissible ?? true, updatedBy: "usr_e2e_ops", updatedAt: new Date().toISOString(),
  };
}

async function mockAnnouncements(page: Page, initial: Body | null = null) {
  const sent: { method: string; body: Body }[] = [];
  let state = initial ? { announcement: stored(initial), status: "live", updatedByEmail: "olive@example.com" } : { announcement: null, status: null, updatedByEmail: null };
  await page.route("**/api/console/announcements", async (r: Route) => {
    const method = r.request().method();
    if (method === "PUT") {
      const body = r.request().postDataJSON() as Body;
      sent.push({ method, body });
      state = { announcement: stored(body), status: "live", updatedByEmail: "olive@example.com" };
      return r.fulfill({ json: { ok: true, ...state } });
    }
    if (method === "DELETE") {
      sent.push({ method, body: r.request().postDataJSON() as Body });
      state = { announcement: null, status: null, updatedByEmail: null };
      return r.fulfill({ json: { ok: true, ...state } });
    }
    return r.fulfill({ json: state });
  });
  return sent;
}

test("an operator writes an announcement, sees the live preview, publishes and removes it with a reason", async ({ page }) => {
  await signUp(page, "Olive Operator");
  await mockConsoleMe(page, "admin");
  const sent = await mockAnnouncements(page);
  await page.goto("/console/announcements");
  await expect(page.getByRole("heading", { name: "Announcements", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("console-announcements-empty")).toContainText("No announcement");

  const text = "Scheduled maintenance tonight from 22:00 UTC.";
  await page.getByTestId("console-announcements-text").fill(text);
  await expect(page.getByTestId("console-announcements-count")).toContainText(`${text.length} of 240`);
  const banner = page.getByTestId("console-announcements-preview").getByTestId("announcement-banner");
  await expect(banner).toContainText(text);
  await expect(banner).toHaveAttribute("data-tone", "info");
  await page.getByTestId("console-announcements-tone-warning").click();
  await expect(banner).toHaveAttribute("data-tone", "warning");
  await page.getByTestId("console-announcements-audience-admins").click();
  await expect(page.getByTestId("console-announcements-who")).toContainText("Owners and admins of every workspace see it as soon as you publish, until you remove it.");

  // A link must be https and comes with a label.
  await page.getByTestId("console-announcements-link-url").fill("http://status.example.com");
  await expect(page.getByText("The link must be a full https:// address.")).toBeVisible();
  await page.getByTestId("console-announcements-link-url").fill("https://status.example.com/");
  await page.getByTestId("console-announcements-link-label").fill("Status page");
  await expect(banner.getByTestId("announcement-link")).toHaveText("Status page");

  // The window uses the app's own date field (the operator's day order, not a fixed mm/dd/yyyy) and a time field.
  const startDay = page.getByTestId("console-announcements-starts");
  await expect(startDay).toHaveAttribute("type", "text");
  await page.getByTestId("console-announcements-starts-time").fill("09:30");
  await expect(page.getByText("Pick a day for this time.")).toBeVisible();
  await startDay.fill("2099-03-04");
  await startDay.blur();
  await expect(startDay).not.toHaveValue("2099-03-04");
  await expect(page.getByTestId("console-announcements-who")).toContainText("from 4 Mar 2099");
  const startsAt = await page.evaluate(() => new Date("2099-03-04T09:30").toISOString());

  await page.getByTestId("console-announcements-publish").click();
  const dialog = page.getByTestId("reason-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Owners and admins of every workspace see it from 4 Mar 2099");
  await dialog.getByLabel("Reason").fill("Planned database work");
  await dialog.getByRole("button", { name: "Publish" }).click();

  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ method: "PUT", body: {
    text, tone: "warning", audience: "admins", linkLabel: "Status page", linkUrl: "https://status.example.com/",
    startsAt, endsAt: null, dismissible: true, reason: "Planned database work",
  } });
  const current = page.getByTestId("console-announcements-current");
  await expect(current).toContainText(text);
  await expect(current).toContainText("Showing now");

  await page.getByTestId("console-announcements-remove").click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill("Work finished");
  await dialog.getByRole("button", { name: "Remove announcement" }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual({ method: "DELETE", body: { reason: "Work finished" } });
  await expect(page.getByTestId("console-announcements-empty")).toBeVisible();
});

test("a support operator sees the current announcement but cannot publish or remove", async ({ page }) => {
  await signUp(page, "Sam Support");
  await mockConsoleMe(page, "ops_support");
  await mockAnnouncements(page, { text: "Mail is delayed." });
  await page.goto("/console/announcements");
  await expect(page.getByTestId("console-announcements-current")).toContainText("Mail is delayed.", { timeout: 15_000 });
  await expect(page.getByTestId("console-announcements-remove")).toHaveCount(0);
  await expect(page.getByTestId("console-announcements-form")).toHaveCount(0);
});
