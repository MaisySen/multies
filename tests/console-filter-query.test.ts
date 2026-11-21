/** OPS1: which console list filters reach the server (components/filter-bar.tsx filterQuery). */
import { describe, it, expect } from "vitest";
import { filterQuery, sendsValue, type FilterDef } from "../src/web/pages/console/components/filter-bar";

const FILTERS: FilterDef[] = [
  { key: "status", label: "Status", initial: "attention", options: [{ value: "attention", label: "Needs attention" }, { value: "all", label: "All", send: true }] },
  { key: "plan", label: "Plan", options: [{ value: "all", label: "Any" }, { value: "pro", label: "Pro" }] },
  { key: "kind", label: "Kind", options: [{ value: "", label: "Any" }, { value: "spam", label: "Spam" }, { value: "noise", label: "Noise", send: false }] },
];

describe("filterQuery", () => {
  it("sends \"all\" only when the option asks for it, never an empty value, and search and sort as they are", () => {
    expect(filterQuery(FILTERS, { q: "acme", sort: "createdAt:desc", status: "all", plan: "all", kind: "" }))
      .toEqual({ q: "acme", sort: "createdAt:desc", status: "all" });
    expect(filterQuery(FILTERS, { q: "", sort: "", status: "attention", plan: "pro", kind: "spam" }))
      .toEqual({ status: "attention", plan: "pro", kind: "spam" });
  });

  it("an option can keep any value out, and a value from the address that no option names is sent unless it is \"all\"", () => {
    expect(sendsValue(FILTERS[2], "noise")).toBe(false);
    expect(sendsValue(FILTERS[0], "failed")).toBe(true);
    expect(sendsValue(FILTERS[1], "all")).toBe(false);
    expect(sendsValue(undefined, "all")).toBe(false);
  });
});
