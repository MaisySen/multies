/**
 * DES1: the web app design pass (DESIGN_DES1) is a set of styles under :root[data-design="des1"] (design-des1.css).
 * The attribute is set from the public config; the last answer is remembered so a reload paints the same look first.
 * With the flag off nothing is set and every page looks exactly as before.
 */
const KEY = "mm.design.des1";

export function applyCachedDesign(): void {
  try { if (localStorage.getItem(KEY) === "1") document.documentElement.dataset.design = "des1"; } catch { /* storage blocked */ }
}

export function syncDesign(on: boolean | undefined): void {
  if (on === undefined) return;
  const el = document.documentElement;
  if (on) el.dataset.design = "des1";
  else delete el.dataset.design;
  try { if (on) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}
