import { useEffect, useRef, useState } from "react";

/** A4 at 96 dpi: the width the templates are laid out for. */
const PAGE_W = 794;
const PAGE_H = 1123;

/**
 * A document preview drawn at its real page width and scaled down to fit, so a narrow column (or a phone)
 * shows the page as it prints instead of rewrapping it.
 */
export function PagePreview({ html, title, testId, maxHeight }: { html: string; title: string; testId?: string; maxHeight?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setW(entries[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = w ? Math.min(1, w / PAGE_W) : 1;
  const h = Math.round(PAGE_H * scale);
  return (
    <div ref={box} className="w-full overflow-hidden bg-white" style={{ height: maxHeight ? Math.min(h, maxHeight) : h }}>
      <iframe title={title} sandbox="" srcDoc={html} data-testid={testId} className="bg-white"
        style={{ width: PAGE_W, height: PAGE_H, border: 0, transform: `scale(${scale})`, transformOrigin: "0 0" }} />
    </div>
  );
}
