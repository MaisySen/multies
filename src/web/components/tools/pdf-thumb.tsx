/**
 * R70: a real picture of page 1 on the Tools result card. The PDF reader loads only when a PDF result is shown,
 * reads the result from its own download link (the same file the Download button gives) and draws page 1 into a
 * small canvas in the browser. Nothing is uploaded and no run is counted. Anything that goes wrong (a very large
 * file, an old browser, a locked PDF) leaves the plain file badge in place.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Results bigger than this keep the badge: drawing them means downloading the whole file twice. */
export const THUMB_MAX_BYTES = 15 * 1024 * 1024;

type Pdfjs = typeof import("pdfjs-dist");
let loader: Promise<Pdfjs> | null = null;
function loadPdfjs(): Promise<Pdfjs> {
  loader ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
    return lib;
  }).catch((err) => { loader = null; throw err; });
  return loader;
}

/**
 * R71 (MB-264): the page count of a PDF the person just chose, read in the browser, so a page limit shows before
 * Run instead of after the upload. Null when it cannot be read (too big, locked, not a PDF); the server still checks.
 */
export async function countPdfPages(file: Blob, maxBytes = 25 * 1024 * 1024): Promise<number | null> {
  if (file.size > maxBytes) return null;
  let destroy: (() => void) | null = null;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const lib = await loadPdfjs();
    const task = lib.getDocument({ data, disableAutoFetch: true, stopAtErrors: false });
    destroy = () => { void task.destroy(); };
    const doc = await task.promise;
    return doc.numPages;
  } catch {
    return null;
  } finally {
    destroy?.();
  }
}

export function PdfThumb({ url, bytes, width = 48, fallback }: { url: string; bytes?: number | null; width?: number; fallback: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "none">(bytes && bytes > THUMB_MAX_BYTES ? "none" : "loading");

  useEffect(() => {
    if (state === "none") return;
    let stopped = false;
    let destroy: (() => void) | null = null;
    (async () => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error("download");
        const data = new Uint8Array(await res.arrayBuffer());
        if (stopped) return;
        const lib = await loadPdfjs();
        const task = lib.getDocument({ data, disableAutoFetch: true, stopAtErrors: false });
        destroy = () => { void task.destroy(); };
        const doc = await task.promise;
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
        const vp = page.getViewport({ scale: (width * dpr) / base.width });
        const c = canvas.current;
        if (stopped || !c) return;
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("canvas");
        await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
        if (!stopped) setState("ok");
      } catch {
        if (!stopped) setState("none");
      } finally {
        destroy?.();
        destroy = null;
      }
    })();
    return () => { stopped = true; destroy?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (state === "none") return <>{fallback}</>;
  return (
    <span className="block shrink-0" style={{ width }} data-testid="tools-result-thumb" data-state={state}>
      {state === "loading" && fallback}
      <canvas ref={canvas} aria-hidden className={`${state === "ok" ? "block" : "hidden"} h-auto w-full rounded-md border border-line bg-white shadow-sm`} />
    </span>
  );
}
