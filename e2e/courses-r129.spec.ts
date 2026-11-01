import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R129 courses (COURSES_R129=on in the e2e server). Flows: Docs > New course and building lessons with a quiz at 1280
 * and 390; a learner fails then passes the quiz and gets a certificate; assigning with a due date, the progress table
 * and CSV, My learning; empty and error states. Axe on every screen. Roles, the key never reaching learners, reminders
 * and guests are in tests/courses-r129.test.ts.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.229.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function axe(page: Page, label: string) {
  await page.waitForTimeout(400);
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
const QUIZ = [{ id: "q1", prompt: "Where do we meet in a fire?", type: "single", options: ["Car park", "Kitchen"], correct: [0], accepted: [] }];

async function seeded(page: Page, title = "Workplace safety") {
  const r = await page.request.post("/api/courses", { data: { title } });
  expect(r.status()).toBe(201);
  const id = ((await r.json()) as { course: { id: string } }).course.id;
  expect((await page.request.post(`/api/courses/${id}/lessons`, { data: { type: "text", title: "Know your exits", body: "Every floor has two exits. Learn where they are." } })).status()).toBe(201);
  expect((await page.request.post(`/api/courses/${id}/lessons`, { data: { type: "quiz", title: "Quick check", quiz: QUIZ } })).status()).toBe(201);
  expect((await page.request.patch(`/api/courses/${id}`, { data: { status: "published" } })).status()).toBe(200);
  return id;
}

test.describe("R129 courses", () => {
  test("build a course from Docs at 1280: lessons, a quiz, publish", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await demo(page);
    await page.goto("/app/docs");
    await page.getByTestId("new-course").click();
    await page.getByLabel("Course name").fill("Onboarding basics");
    await page.getByTestId("create-course").click();
    await expect(page.getByTestId("course-page")).toBeVisible();
    await expect(page.getByText("Add the first lesson")).toBeVisible();
    await axe(page, "build empty");
    await shot(page, "build-empty-1280-light");
    await page.getByTestId("add-lesson").first().click();
    await page.getByTestId("lesson-type").selectOption("text");
    await page.getByTestId("lesson-title").fill("Welcome");
    await page.getByTestId("lesson-body").fill("Read this first.");
    await page.getByTestId("save-lesson").click();
    await expect(page.getByTestId("build-lesson-0")).toContainText("Welcome");
    await page.getByTestId("add-lesson").first().click();
    await page.getByTestId("lesson-type").selectOption("quiz");
    await page.getByTestId("lesson-title").fill("Check");
    await page.getByTestId("save-lesson").click();
    await expect(page.getByTestId("lesson-error")).toContainText("needs a question");
    await page.getByLabel("Question 1", { exact: true }).fill("Who do you call first?");
    await page.getByLabel("Option 1", { exact: true }).fill("Your manager");
    await page.getByLabel("Option 2", { exact: true }).fill("Nobody");
    await page.getByLabel("Option 1 is right").check();
    await axe(page, "lesson dialog");
    await shot(page, "quiz-editor-1280-light");
    await page.getByTestId("save-lesson").click();
    await expect(page.getByTestId("build-lesson-1")).toContainText("Check");
    await page.getByRole("button", { name: "Move Check up" }).click();
    await expect(page.getByTestId("build-lesson-0")).toContainText("Check");
    await page.getByTestId("publish-course").click();
    await expect(page.getByText("Published", { exact: true })).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark" });
    await axe(page, "build dark");
    await shot(page, "build-1280-dark");
  });

  test("learner fails then passes the quiz and gets a certificate", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await demo(page);
    const id = await seeded(page);
    await page.goto(`/app/docs/${id}?tab=learn`);
    await page.getByTestId("start-course").click();
    await expect(page.getByText("Every floor has two exits.")).toBeVisible();
    await axe(page, "learn");
    await shot(page, "learn-1280-light");
    await page.getByTestId("mark-done").click();
    await page.getByLabel("Kitchen").check();
    await page.getByTestId("submit-quiz").click();
    await expect(page.getByTestId("quiz-result")).toContainText("You scored 0%");
    await expect(page.getByText("Not quite right")).toBeVisible();
    await shot(page, "quiz-failed-1280-light");
    await page.getByLabel("Car park").check();
    await page.getByTestId("submit-quiz").click();
    await expect(page.getByTestId("quiz-result")).toContainText("You passed with 100%");
    await expect(page.getByTestId("course-complete")).toBeVisible();
    const href = await page.getByTestId("download-certificate").getAttribute("href");
    const pdf = await page.request.get(href!);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    await axe(page, "complete");
    await shot(page, "complete-1280-light");
    await page.goto("/app/docs/learning");
    await expect(page.getByTestId("my-learning")).toContainText("Workplace safety");
    await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
    await axe(page, "my learning");
    await shot(page, "my-learning-1280-light");
  });

  test("assign with a due date, then the progress table and CSV", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await demo(page);
    const id = await seeded(page, "Privacy at work");
    await page.goto(`/app/docs/${id}?tab=assign`);
    await page.getByRole("switch", { name: "Everyone in the workspace" }).click();
    const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await page.getByTestId("assign-due").fill(due);
    await page.getByTestId("assign-due").press("Tab");
    await page.getByTestId("assign-course").click();
    await expect(page.getByText(/Assigned to \d+ (person|people)/)).toBeVisible();
    await axe(page, "assign");
    await shot(page, "assign-1280-light");
    await page.getByTestId("course-tab-progress").click();
    await expect(page.getByTestId("progress-table")).toBeVisible();
    await expect(page.getByTestId("progress-table")).toContainText("Not started");
    const csv = await page.request.get(`/api/courses/${id}/progress.csv`);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect((await csv.text()).split("\r\n")[0]).toContain("Name,Email,Status");
    await axe(page, "progress");
    await shot(page, "progress-1280-light");
    await page.goto("/app/docs/learning");
    await expect(page.getByRole("heading", { name: "Assigned to you" })).toBeVisible();
  });

  test("works at 390: build, learn, progress stacked, no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await demo(page);
    const id = await seeded(page, "Phone course");
    await page.goto(`/app/docs/${id}?tab=build`);
    await expect(page.getByTestId("build-lesson-0")).toBeVisible();
    await noHScroll(page);
    await axe(page, "build 390");
    await shot(page, "build-390-light");
    await page.getByTestId("course-tab-learn").click();
    await page.getByTestId("start-course").click();
    await expect(page.getByLabel("Lesson", { exact: true })).toBeVisible();
    await noHScroll(page);
    await axe(page, "learn 390");
    await shot(page, "learn-390-light");
    await page.getByTestId("course-tab-progress").click();
    await expect(page.getByText("1 learner, 0 completed")).toBeVisible();
    await noHScroll(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await axe(page, "progress 390 dark");
    await shot(page, "progress-390-dark");
  });

  test("empty and error states", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await demo(page);
    await page.goto("/app/docs/learning");
    await expect(page.getByText("Nothing to learn yet")).toBeVisible();
    await axe(page, "my learning empty");
    await shot(page, "my-learning-empty-1280-light");
    const id = await seeded(page, "Error course");
    await page.route(`**/api/courses/${id}`, (r) => r.request().method() === "GET" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "boom", message: "Server error" } }) }) : r.continue());
    await page.goto(`/app/docs/${id}`);
    await expect(page.getByText("Couldn't load this course")).toBeVisible({ timeout: 20_000 });
    await page.unroute(`**/api/courses/${id}`);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("course-page")).toBeVisible();
    await axe(page, "after retry");
  });
});
