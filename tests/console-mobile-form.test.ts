/**
 * OPS1: the Mobile app config form's logic (web/pages/console/mobile-form.ts): sections, parsing and validation
 * per field type, the patch of changed fields only, and which changes raise a minimum.
 */
import { describe, expect, it } from "vitest";
import { MOBILE_CONFIG_FIELDS } from "../src/server/services/console/mobile-config";
import { appConfigPatch, resolveAppConfig } from "../src/server/routes/app-config-r29b";
import { compareVersions, draftsOf, parseDraft, raisedMinimums, reviewOf, sectionsOf, showValue, type MobileField } from "../src/web/pages/console/mobile-form";

const fields = MOBILE_CONFIG_FIELDS as unknown as MobileField[];
const byPath = (p: string) => fields.find((f) => f.path === p)!;
const ID = "019a1b2c-3d4e-7f00-8a11-223344556677";

describe("mobile form", () => {
  it("groups every field into the three sections", () => {
    const s = sectionsOf(fields);
    expect(s.map((x) => x.id)).toEqual(["minimum", "updates", "message"]);
    expect(s.flatMap((x) => x.fields).length).toBe(fields.length);
  });

  it("parses and validates each field type", () => {
    expect(parseDraft(byPath("min_supported.ios.build"), "")).toEqual({ ok: true, value: null });
    expect(parseDraft(byPath("min_supported.ios.build"), "42")).toEqual({ ok: true, value: 42 });
    expect(parseDraft(byPath("min_supported.ios.build"), "4.2").ok).toBe(false);
    expect(parseDraft(byPath("min_supported.ios.version"), "1.4.0")).toEqual({ ok: true, value: "1.4.0" });
    expect(parseDraft(byPath("min_supported.ios.version"), "v1").ok).toBe(false);
    expect(parseDraft(byPath("store_url.ios"), "https://play.google.com/x").ok).toBe(false);
    expect(parseDraft(byPath("store_url.android"), "").ok).toBe(false);
    expect(parseDraft(byPath("ota.check_interval_minutes"), "4").ok).toBe(false);
    expect(parseDraft(byPath("ota.check_interval_minutes"), "1441").ok).toBe(false);
    expect(parseDraft(byPath("ota.check_interval_minutes"), "").ok).toBe(false);
    expect(parseDraft(byPath("ota.critical_update_ids"), `${ID.toUpperCase()}\n${ID}, `)).toEqual({ ok: true, value: [ID] });
    expect(parseDraft(byPath("ota.critical_update_ids"), "nope").ok).toBe(false);
    expect(parseDraft(byPath("message"), "x".repeat(201)).ok).toBe(false);
    expect(parseDraft(byPath("message"), "  ")).toEqual({ ok: true, value: null });
  });

  it("builds a patch of changed fields only, which the server accepts", () => {
    const effective = resolveAppConfig({}, undefined, null).mobile;
    const drafts = draftsOf(fields, effective);
    expect(reviewOf(fields, effective, drafts).changes).toEqual([]);
    const r = reviewOf(fields, effective, { ...drafts, "min_supported.ios.build": "42", "ota.critical_update_ids": ID, message: "Please update." });
    expect(r.errors).toEqual({});
    expect(r.patch).toEqual({ min_supported: { ios: { build: 42 } }, ota: { critical_update_ids: [ID] }, message: "Please update." });
    expect(appConfigPatch.safeParse(r.patch).success).toBe(true);
    expect(raisedMinimums(r.changes).map((c) => c.field.path)).toEqual(["min_supported.ios.build"]);
    const bad = reviewOf(fields, effective, { ...drafts, "ota.check_interval_minutes": "x" });
    expect(Object.keys(bad.errors)).toEqual(["ota.check_interval_minutes"]);
  });

  it("only a new or higher minimum counts as raising it", () => {
    const f = byPath("min_supported.android.version");
    expect(raisedMinimums([{ field: f, before: "1.4.0", after: "1.3.9" }])).toHaveLength(0);
    expect(raisedMinimums([{ field: f, before: "1.4.0", after: null }])).toHaveLength(0);
    expect(raisedMinimums([{ field: f, before: "1.4", after: "1.4.1" }])).toHaveLength(1);
    expect(compareVersions("1.4", "1.4.0")).toBe(0);
    expect(compareVersions("1.10", "1.9")).toBe(1);
    expect(showValue(f, null)).toBe("Any version");
    expect(showValue(byPath("ota.blocked_update_ids"), [])).toBe("None");
  });
});
