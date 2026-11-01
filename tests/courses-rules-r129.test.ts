/** R129: course rules (shared): quiz scoring and pass mark, no key for learners, completion, status, reminders, CSV. */
import { describe, it, expect } from "vitest";
import { checkQuestions, courseProgress, csvCell, isRight, learnerStatus, publicQuestions, reminderDue, safeLink, scoreQuiz, SOON_MS, toCsv, type Question } from "../src/shared/courses-r129";

const Q: Question[] = [
  { id: "a", prompt: "Pick one", type: "single", options: ["x", "y", "z"], correct: [1], accepted: [] },
  { id: "b", prompt: "Pick all", type: "multi", options: ["p", "q", "r"], correct: [0, 2], accepted: [] },
  { id: "c", prompt: "Say it", type: "short", options: [], correct: [], accepted: ["Fire exit", "exit"] },
];

describe("R129 quiz scoring", () => {
  it("checks each question type", () => {
    expect(isRight(Q[0], 1)).toBe(true);
    expect(isRight(Q[0], 0)).toBe(false);
    expect(isRight(Q[0], "1")).toBe(false);
    expect(isRight(Q[1], [2, 0])).toBe(true);
    expect(isRight(Q[1], [0])).toBe(false);
    expect(isRight(Q[1], [0, 1, 2])).toBe(false);
    expect(isRight(Q[1], [0, 0, 2, 2])).toBe(true);
    expect(isRight(Q[2], "  FIRE   exit ")).toBe(true);
    expect(isRight(Q[2], "")).toBe(false);
    expect(isRight(Q[2], 3)).toBe(false);
  });
  it("scores, applies the pass mark and names only the wrong questions", () => {
    const all = scoreQuiz(Q, { a: 1, b: [0, 2], c: "exit" }, 80);
    expect(all).toMatchObject({ score: 100, right: 3, total: 3, passed: true, wrong: [] });
    const two = scoreQuiz(Q, { a: 1, b: [0], c: "exit" }, 80);
    expect(two).toMatchObject({ score: 66, passed: false, wrong: ["b"] });
    expect(scoreQuiz(Q, { a: 1, b: [0], c: "exit" }, 66).passed).toBe(true);
    expect(scoreQuiz([], {}, 0).passed).toBe(false);
    expect(JSON.stringify(two)).not.toContain("correct");
  });
  it("never gives learners the key", () => {
    const pub = publicQuestions(Q);
    const text = JSON.stringify(pub);
    expect(text).not.toContain("correct");
    expect(text).not.toContain("accepted");
    expect(text).not.toContain("Fire exit");
    expect(pub[2].options).toEqual([]);
  });
  it("refuses a quiz that cannot be passed", () => {
    expect(checkQuestions(Q)).toBeNull();
    expect(checkQuestions([{ ...Q[0], correct: [] }])).toMatch(/right answer/);
    expect(checkQuestions([{ ...Q[0], correct: [0, 1] }])).toMatch(/only one/);
    expect(checkQuestions([{ ...Q[0], options: ["x"] }])).toMatch(/two options/);
    expect(checkQuestions([{ ...Q[0], correct: [5] }])).toMatch(/right answer/);
    expect(checkQuestions([{ ...Q[2], accepted: [" "] }])).toMatch(/accepted answer/);
    expect(checkQuestions([{ ...Q[0], prompt: " " }])).toMatch(/needs a question/);
    expect(checkQuestions([Q[0], Q[0]])).toMatch(/same id/);
  });
});

describe("R129 completion and status", () => {
  const L = (id: string, type: "page" | "quiz", required: boolean, done = false, passed = false) => ({ id, type, required, done, passed });
  it("counts required lessons, and a quiz only when passed", () => {
    expect(courseProgress([L("1", "page", true, true), L("2", "quiz", true, true, false)])).toMatchObject({ percent: 50, complete: false });
    expect(courseProgress([L("1", "page", true, true), L("2", "quiz", true, false, true)])).toMatchObject({ percent: 100, complete: true });
    expect(courseProgress([L("1", "page", true, true), L("2", "page", false)])).toMatchObject({ total: 1, complete: true });
    expect(courseProgress([L("1", "page", false, true), L("2", "page", false)])).toMatchObject({ total: 2, percent: 50 });
    expect(courseProgress([])).toMatchObject({ percent: 0, complete: false });
  });
  it("says where a learner is", () => {
    const now = 1_000_000_000;
    expect(learnerStatus({}, now)).toBe("not_started");
    expect(learnerStatus({ startedAt: 1 }, now)).toBe("in_progress");
    expect(learnerStatus({ startedAt: 1, dueAt: now - 1 }, now)).toBe("overdue");
    expect(learnerStatus({ completedAt: 5, dueAt: now - 1 }, now)).toBe("completed");
  });
  it("sends one due soon and one overdue reminder", () => {
    const now = 10 * SOON_MS;
    expect(reminderDue({ dueAt: now + SOON_MS + 1 }, now)).toBeNull();
    expect(reminderDue({ dueAt: now + SOON_MS }, now)).toBe("soon");
    expect(reminderDue({ dueAt: now + 5, remindedSoonAt: 1 }, now)).toBeNull();
    expect(reminderDue({ dueAt: now - 1, remindedSoonAt: 1 }, now)).toBe("overdue");
    expect(reminderDue({ dueAt: now - 1, remindedOverdueAt: 1 }, now)).toBeNull();
    expect(reminderDue({ dueAt: now - 1, completedAt: 3 }, now)).toBeNull();
    expect(reminderDue({ dueAt: null }, now)).toBeNull();
  });
});

describe("R129 CSV and links", () => {
  it("quotes and defuses spreadsheet formulas", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(toCsv([["a", 1], [null, "x"]])).toBe("a,1\r\n,x\r\n");
  });
  it("keeps only http links", () => {
    expect(safeLink("https://example.com/v")).toBe("https://example.com/v");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("not a link")).toBeNull();
  });
});
