/**
 * R49 mobile web: keep composers above the on screen keyboard. iOS Safari does not shrink the layout viewport when
 * the keyboard opens (only the visual viewport), so a bottom composer ends up under the keys. We read the visual
 * viewport, publish the keyboard height as --kb-h on <html> with data-kb="open", and the phone CSS shrinks the app
 * shell to the visible area and hides the tab bar while typing, the way native chat apps do.
 */

/** Smaller gaps are the browser's own bars moving, not a keyboard. */
export const KEYBOARD_MIN_PX = 120;

/** Height in px the keyboard covers at the bottom of the layout viewport, or 0 when it is closed. */
export function keyboardInset(layoutHeight: number, visualHeight: number, visualOffsetTop = 0): number {
  if (!Number.isFinite(layoutHeight) || !Number.isFinite(visualHeight) || layoutHeight <= 0 || visualHeight <= 0) return 0;
  const covered = Math.round(layoutHeight - visualHeight - Math.max(0, visualOffsetTop));
  return covered >= KEYBOARD_MIN_PX ? covered : 0;
}

/** Starts watching (phones only). Returns a function that stops it and clears the marks. */
export function watchKeyboardInset(win: Window = window): () => void {
  const vv = win.visualViewport;
  const root = win.document.documentElement;
  if (!vv || !win.matchMedia("(max-width: 767.98px)").matches) return () => {};
  let last = -1;
  const apply = () => {
    const kb = keyboardInset(win.innerHeight, vv.height, vv.offsetTop);
    if (kb === last) return;
    last = kb;
    if (kb > 0) {
      root.style.setProperty("--kb-h", `${kb}px`);
      root.dataset.kb = "open";
      // iOS pans the page to show the field; the shell now fits the visible area, so pan back.
      if (win.scrollY) win.scrollTo(0, 0);
    } else {
      root.style.removeProperty("--kb-h");
      delete root.dataset.kb;
    }
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    root.style.removeProperty("--kb-h");
    delete root.dataset.kb;
  };
}
