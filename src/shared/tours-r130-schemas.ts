/**
 * R130: the zod schemas for tours (API validation and the tour builder's page check). Kept apart from
 * ./tours-r130 so the app's first screens, which only need the plain helpers, do not load zod.
 */
import { z } from "zod";
import { AUDIENCES, MAX_STEPS, PAGE_PATH_RE, PROGRESS_KEY_RE, TARGET_RE } from "./tours-r130";

export const Target = z.string().trim().regex(TARGET_RE, "Pick an element on the page.");
/** Plain text only: control characters (other than tab and new line) are dropped. */
const stripControl = (s: string) => [...s].filter((ch) => { const c = ch.charCodeAt(0); return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127); }).join("");
const plain = (max: number) => z.string().trim().max(max).transform(stripControl);
export const TourStep = z.object({ target: Target, title: plain(80).pipe(z.string().min(1, "Give each step a title.")), body: plain(400) });
export type TourStep = z.infer<typeof TourStep>;
export const PagePath = z.string().trim().max(120).regex(PAGE_PATH_RE, "Pick a page in the app.");
const tourFields = {
  name: plain(80).pipe(z.string().min(1, "Give the tour a name.")),
  page: PagePath,
  audience: z.enum(AUDIENCES),
  newDays: z.number().int().min(1).max(365).nullable(),
  steps: z.array(TourStep).max(MAX_STEPS, `Up to ${MAX_STEPS} steps.`),
};
export const TourInput = z.object({ ...tourFields, audience: tourFields.audience.default("all"), newDays: tourFields.newDays.default(null), steps: tourFields.steps.default([]) });
export type TourInput = z.infer<typeof TourInput>;
/** A change: only the fields sent are touched (no defaults, so a publish never resets the audience). */
export const TourPatch = z.object({ ...tourFields, status: z.enum(["draft", "published"]) }).partial();
export type TourPatch = z.infer<typeof TourPatch>;

export const ProgressInput = z.object({ key: z.string().regex(PROGRESS_KEY_RE), state: z.enum(["done", "skipped"]), step: z.number().int().min(0).max(50).default(0) });
