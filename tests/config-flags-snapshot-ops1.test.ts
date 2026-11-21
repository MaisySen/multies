/**
 * OPS1 feature flags: /api/config answers its flag booleans from the flag engine (global overrides only). With no
 * override rows the whole response must be byte for byte what it was before the engine was wired in. The expected
 * bodies in tests/fixtures/config-snapshot-ops1.json were recorded from the code before that change (plus the one
 * allowed addition, `announcement: null`, when no announcement is stored).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers";
import { featureFlagOverrides } from "@/server/db/schema";
import { envDefault, invalidateFlagOverrides } from "@/server/services/console/flags";
import { FEATURE_FLAGS, type FlagDef, type FlagKey } from "@/shared/feature-flags";

const FIXTURE = join(__dirname, "fixtures", "config-snapshot-ops1.json");

/** Two deployments: the defaults, and several flags on (some through FEATURES, some on-unless-off ones turned off). */
export const SNAPSHOT_ENVS: Record<string, Record<string, string>> = {
  defaults: {},
  several: {
    CRM_TIMELINE: "on", TASKS_PLUS_R95: "on", SEARCH_R98: "on", MAPS_R115: "on", ASK_R110: "on", ASK_TD1: "on",
    INVOICES_ENABLED: "1", EXPENSES_R106: "on", BILL_TD4: "on", FILES_PLUS_R101: "on", DOC_INBOX_R102: "on",
    SCHEDULING_ENABLED: "true", BOOKING_PLUS: "true", FORMS_PLUS_R93: "on", FORMS_TD2: "on", MAIL_ARCHIVE_R111: "on",
    CLIENT_PORTAL: "on", PORTAL_TD9: "on", FEATURES: "LANG_R104,TRANSLATE_R116", FLOWS: "off", DOCS_VISUAL: "off",
    SOCIAL_P2B: "off", NAV_P2_R121: "on", PASSKEY_DES1: "on", AI_CONNECT_AI2: "on", CHAT_CHANNELS: "on",
  },
};

afterEach(() => invalidateFlagOverrides());

async function body(env: Record<string, string>) {
  const { app, db, deps } = await makeTestApp(env);
  return { text: await (await app.request("/api/config")).text(), app, db, deps };
}

describe("/api/config with the flag engine", () => {
  it("is byte for byte the recorded response with no override rows", async () => {
    const got: Record<string, string> = {};
    for (const [name, env] of Object.entries(SNAPSHOT_ENVS)) got[name] = (await body(env)).text;
    if (process.env.RECORD_CONFIG_SNAPSHOT === "1") writeFileSync(FIXTURE, `${JSON.stringify(got, null, 2)}\n`);
    const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
    for (const name of Object.keys(SNAPSHOT_ENVS)) expect(got[name], name).toBe(want[name]);
  }, 120_000);

  it("a global override flips exactly its own key", async () => {
    const defs = (FEATURE_FLAGS as readonly FlagDef[]).filter((d) => d.runtime && d.clientKey);
    for (const [name, env] of Object.entries(SNAPSHOT_ENVS)) {
      const { app, db, text, deps } = await body(env);
      const base = JSON.parse(text) as Record<string, unknown>;
      for (const def of defs) {
        // Turn it the other way globally; the client value of a flag also needs its requirements, so pick a flag
        // whose requirements hold here, or whose value is on (turning it off always shows).
        const ck = def.clientKey as string;
        const value = !(base[ck] as boolean);
        await db.insert(featureFlagOverrides).values({ key: def.key, scopeId: "", value: value ? "on" : "off", locked: false, updatedAt: new Date() });
        invalidateFlagOverrides();
        const next = JSON.parse(await (await app.request("/api/config")).text()) as Record<string, unknown>;
        const changed = Object.keys(base).filter((k) => JSON.stringify(base[k]) !== JSON.stringify(next[k]));
        const reqsMet = (def.requires ?? []).every((r) => envDefault(deps.config, r as FlagKey))
          && (def.needsConfig ?? []).every((p) => p !== "meetings" || base.meetings === true);
        if (value && !reqsMet) expect(changed, `${name} ${def.key}`).toEqual([]);
        else {
          // Flags other flags require (for example invoices for expenses) can carry those along when they turn off.
          const dependants = (FEATURE_FLAGS as readonly FlagDef[]).filter((d) => d.clientKey && (d.requires ?? []).includes(def.key)).map((d) => d.clientKey as string);
          expect(changed, `${name} ${def.key}`).toContain(ck);
          expect(changed.filter((k) => k !== ck && !dependants.includes(k)), `${name} ${def.key}`).toEqual([]);
        }
        await db.delete(featureFlagOverrides);
        invalidateFlagOverrides();
      }
    }
  }, 120_000);
});
