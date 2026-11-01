/** The year and month the page shows: the browser runs in Sydney time, so near a month boundary the UTC month differs. */
export function sydneyMonth(now: Date): { y: number; m: number } {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "numeric", month: "numeric" }).formatToParts(now);
  return { y: Number(parts.find((p) => p.type === "year")!.value), m: Number(parts.find((p) => p.type === "month")!.value) - 1 };
}
