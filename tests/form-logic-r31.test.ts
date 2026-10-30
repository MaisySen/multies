import { describe, it, expect } from "vitest";
import { pickRoute, answerList, answerText, checkAnswers, checkLogic, cleanLogic, conditionHolds, fieldError, findCycle, normaliseLogic, normaliseRules, safePattern, visibleFieldIds, type LogicField } from "@/shared/form-logic";

/** R31: form logic and answer rules, one pure module for the page and the server. */
const q = (id: string, extra: Partial<LogicField> = {}): LogicField => ({ id, label: id.toUpperCase(), type: "text", required: false, ...extra });
const yes = q("q1", { type: "select", options: ["Yes", "No"], required: true });
const why = q("q2", { required: true, logic: { join: "all", conditions: [{ field: "q1", op: "is", value: "Yes" }] } });

describe("visibility", () => {
  it("shows a question only when its condition holds, and a hidden one is never required", () => {
    expect([...visibleFieldIds([yes, why], {})]).toEqual(["q1"]);
    expect([...visibleFieldIds([yes, why], { q1: "yes" })]).toEqual(["q1", "q2"]);
    const hidden = checkAnswers([yes, why], { q1: "No", q2: "left over" });
    expect(hidden.errors).toEqual({});
    expect(hidden.answers).toEqual({ q1: "No" }); // the hidden answer is dropped
    const shown = checkAnswers([yes, why], { q1: "Yes" });
    expect(shown.errors).toEqual({ q2: 'Please fill in "Q2".' });
  });

  it("cascades: a question that depends on a hidden one reads it as unanswered", () => {
    const q3 = q("q3", { logic: { join: "all", conditions: [{ field: "q2", op: "answered" }] } });
    expect(visibleFieldIds([yes, why, q3], { q1: "No", q2: "x" }).has("q3")).toBe(false);
    expect(visibleFieldIds([yes, why, q3], { q1: "Yes", q2: "x" }).has("q3")).toBe(true);
  });

  it("joins conditions with all or any", () => {
    const n = q("n", { type: "number" });
    const all = q("t", { logic: { join: "all", conditions: [{ field: "n", op: "gt", value: "5" }, { field: "n", op: "lt", value: "10" }] } });
    const any = { ...all, logic: { ...all.logic!, join: "any" as const } };
    expect(visibleFieldIds([n, all], { n: "7" }).has("t")).toBe(true);
    expect(visibleFieldIds([n, all], { n: "12" }).has("t")).toBe(false);
    expect(visibleFieldIds([n, any], { n: "12" }).has("t")).toBe(true);
  });

  it("each operator", () => {
    const t = q("a");
    expect(conditionHolds(t, { field: "a", op: "is", value: "Blue" }, "blue")).toBe(true);
    expect(conditionHolds(t, { field: "a", op: "is_not", value: "Blue" }, "red")).toBe(true);
    expect(conditionHolds(t, { field: "a", op: "contains", value: "urg" }, "Urgent please")).toBe(true);
    expect(conditionHolds(t, { field: "a", op: "contains", value: "" }, "x")).toBe(false);
    expect(conditionHolds(t, { field: "a", op: "answered" }, "")).toBe(false);
    expect(conditionHolds(t, { field: "a", op: "not_answered" }, "")).toBe(true);
    expect(conditionHolds(q("d", { type: "date" }), { field: "d", op: "gt", value: "2026-10-01" }, "2026-10-26")).toBe(true);
    expect(conditionHolds(q("n", { type: "number" }), { field: "n", op: "lt", value: "3" }, "")).toBe(false);
    expect(conditionHolds(q("n", { type: "number" }), { field: "n", op: "gt", value: "abc" }, "4")).toBe(false);
    const m = q("m", { type: "multiselect", options: ["Red", "Green", "Blue"] });
    expect(conditionHolds(m, { field: "m", op: "is", value: "green" }, "Red, Green")).toBe(true);
    expect(conditionHolds(m, { field: "m", op: "is_not", value: "Blue" }, "Red, Green")).toBe(true);
    expect(conditionHolds(m, { field: "m", op: "contains", value: "Blue" }, "Red, Green")).toBe(false);
  });

  it("a condition on a question that was deleted never hides anything", () => {
    const orphan = q("x", { logic: { join: "all", conditions: [{ field: "gone", op: "is", value: "1" }] } });
    expect(visibleFieldIds([orphan], {}).has("x")).toBe(true);
  });
});

describe("checking the logic", () => {
  it("refuses a loop, a self reference and a reference to a later question", () => {
    const a = q("a", { logic: { join: "all", conditions: [{ field: "b", op: "answered" }] } });
    const b = q("b", { logic: { join: "all", conditions: [{ field: "a", op: "answered" }] } });
    expect(findCycle([a, b])).toEqual(["a", "b", "a"]);
    expect(checkLogic([a, b]).map((p) => p.code)).toContain("cycle");
    const self = q("s", { logic: { join: "all", conditions: [{ field: "s", op: "answered" }] } });
    expect(checkLogic([self])[0].code).toBe("self");
    const later = q("first", { logic: { join: "all", conditions: [{ field: "second", op: "answered" }] } });
    const problems = checkLogic([later, q("second")]);
    expect(problems.map((p) => p.code)).toEqual(["later"]);
    expect(problems[0].message).toBe('"FIRST" can only depend on a question above it, not "SECOND".');
    expect(checkLogic([yes, why])).toEqual([]);
  });

  it("needs a value for value operators, knows its operators, caps conditions", () => {
    const noValue = q("b", { logic: { join: "all", conditions: [{ field: "q1", op: "is" }] } });
    expect(checkLogic([yes, noValue])[0].code).toBe("missing_value");
    const badOp = q("b", { logic: { join: "all", conditions: [{ field: "q1", op: "near" as never, value: "x" }] } });
    expect(checkLogic([yes, badOp])[0].code).toBe("unknown_op");
    const many = q("b", { logic: { join: "any", conditions: Array.from({ length: 11 }, () => ({ field: "q1", op: "answered" as const })) } });
    expect(checkLogic([yes, many])[0].code).toBe("too_many");
  });

  it("cleans up conditions on deleted questions", () => {
    const f = q("b", { logic: { join: "any", conditions: [{ field: "gone", op: "answered" }, { field: "q1", op: "is", value: "Yes" }] } });
    expect(cleanLogic([yes, f])[1].logic).toEqual({ join: "any", conditions: [{ field: "q1", op: "is", value: "Yes" }] });
    const only = q("c", { logic: { join: "all", conditions: [{ field: "gone", op: "answered" }] } });
    expect(cleanLogic([only])[0].logic).toBeNull();
  });

  it("refuses rules that contradict themselves", () => {
    expect(checkLogic([q("a", { rules: { minLength: 9, maxLength: 3 } })])[0].code).toBe("bad_rule");
    expect(checkLogic([q("n", { type: "number", rules: { min: 9, max: 3 } })])[0].code).toBe("bad_rule");
    expect(checkLogic([q("m", { type: "multiselect", options: ["a", "b"], rules: { minSelected: 3 } })])[0].code).toBe("bad_rule");
    expect(checkLogic([q("p", { rules: { pattern: "(a+)+" } })])[0].code).toBe("bad_rule");
  });

  it("normalises raw logic and keeps only the rules a type can use", () => {
    expect(normaliseLogic({ join: "whatever", conditions: [{ field: " q1 ", op: "answered", value: "dropped" }] })).toEqual({ join: "all", conditions: [{ field: "q1", op: "answered" }] });
    expect(normaliseLogic({ conditions: [] })).toBeNull();
    expect(normaliseLogic("nope")).toBeNull();
    expect(normaliseRules("number", { min: "1", max: 5, minLength: 3 })).toEqual({ min: 1, max: 5 });
    expect(normaliseRules("text", { minLength: 2.7, pattern: " [A-Z]{3} " })).toEqual({ minLength: 2, pattern: "[A-Z]{3}" });
    expect(normaliseRules("multiselect", { minSelected: 2 })).toEqual({ minSelected: 2 });
    expect(normaliseRules("date", { min: 1 })).toBeNull();
  });

  it("accepts simple patterns only", () => {
    expect(safePattern("[A-Z]{2}\\d{4}")).toBe(true);
    expect(safePattern("(")).toBe(false);
    expect(safePattern("(a)\\1")).toBe(false);
    expect(safePattern("x".repeat(201))).toBe(false);
  });
});

describe("answer rules", () => {
  it("text length, number range, email, date, pattern", () => {
    expect(fieldError(q("a", { rules: { minLength: 3 } }), "ab")).toBe('"A" needs at least 3 characters.');
    expect(fieldError(q("a", { rules: { maxLength: 3 } }), "abcd")).toBe('"A" can be up to 3 characters.');
    expect(fieldError(q("n", { type: "number", rules: { min: 1, max: 10 } }), "0")).toBe('"N" should be 1 or more.');
    expect(fieldError(q("n", { type: "number", rules: { min: 1, max: 10 } }), "11")).toBe('"N" should be 10 or less.');
    expect(fieldError(q("n", { type: "number" }), "ten")).toBe('"N" should be a number.');
    expect(fieldError(q("e", { type: "email" }), "nope")).toBe('"E" doesn\'t look like an email address.');
    expect(fieldError(q("d", { type: "date" }), "26/10/2026")).toBe('"D" should be a date.');
    expect(fieldError(q("p", { rules: { pattern: "[A-Z]{3}" } }), "abc")).toBe('"P" isn\'t in the expected format.');
    expect(fieldError(q("p", { rules: { pattern: "[A-Z]{3}", patternMessage: "Three capital letters, like ABC." } }), "ab")).toBe("Three capital letters, like ABC.");
    expect(fieldError(q("p", { rules: { pattern: "[A-Z]{3}" } }), "ABC")).toBeNull();
    expect(fieldError(q("o", { required: false }), "")).toBeNull();
  });

  it("multi-select: at least and at most, only listed options, stored in option order", () => {
    const m = q("m", { type: "multiselect", options: ["Red", "Green, light", "Blue"], required: true, rules: { minSelected: 2, maxSelected: 2 } });
    expect(answerText(m, ["Blue", "Red"])).toBe("Red, Blue");
    expect(answerList(m, "Red, Green, light")).toEqual(["Red", "Green, light"]);
    expect(fieldError(m, "")).toBe('Please choose an answer for "M".');
    expect(fieldError(m, "Red")).toBe('Pick at least 2 for "M".');
    expect(fieldError(m, "Red, Green, light, Blue")).toBe('Pick up to 2 for "M".');
    expect(fieldError(m, "Red, Purple")).toBe('Pick from the options for "M".');
    expect(checkAnswers([m], { m: ["Green, light", "Red"] })).toMatchObject({ errors: {}, answers: { m: "Red, Green, light" } });
  });

  it("collects every field's error at once and caps stored text", () => {
    const r = checkAnswers([q("a", { required: true }), q("e", { type: "email" }), q("long")], { e: "x", long: "y".repeat(900) });
    expect(Object.keys(r.errors)).toEqual(["a", "e"]);
    expect(checkAnswers([q("long")], { long: "y".repeat(900) }).answers.long).toHaveLength(500);
  });
});

describe("routing", () => {
  it("picks the first rule that matches, and none when nothing does", () => {
    const routes = [
      { when: { field: "q1", op: "is" as const, value: "Yes" }, projectId: "prj_a" },
      { when: { field: "q2", op: "answered" as const }, projectId: "prj_b" },
      { when: { field: "gone", op: "answered" as const }, projectId: "prj_c" },
    ];
    expect(pickRoute([yes, why], routes, { q1: "Yes", q2: "x" })?.projectId).toBe("prj_a");
    expect(pickRoute([yes, why], routes, { q1: "No", q2: "x" })?.projectId).toBe("prj_b");
    expect(pickRoute([yes, why], routes, { q1: "No" })).toBeNull();
  });
});
