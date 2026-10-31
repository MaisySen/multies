/** R89: a saved whiteboard as a still picture (Present, and anywhere a live board is not needed). Its own chunk. */
import { useEffect, useState } from "react";
import { exportToSvg, restoreElements } from "@excalidraw/excalidraw";
import { readScene } from "@/web/lib/whiteboard-merge";
import { isDark, useThemeKey } from "./theme";

export default function BoardPicture({ scene }: { scene: string }) {
  const themeKey = useThemeKey();
  const [svg, setSvg] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    let live = true;
    if (typeof window !== "undefined") window.EXCALIDRAW_ASSET_PATH = "/board-assets/";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the library's element union
    const elements = restoreElements(readScene(scene).filter((e) => !e.isDeleted) as any, null);
    if (!elements.length) { setEmpty(true); return; }
    exportToSvg({ elements, appState: { exportBackground: false, exportWithDarkMode: isDark(), viewBackgroundColor: "transparent" }, files: null, exportPadding: 16 })
      .then((el: SVGSVGElement) => { if (live) { el.removeAttribute("width"); el.removeAttribute("height"); setSvg(new XMLSerializer().serializeToString(el)); } })
      .catch(() => { if (live) setEmpty(true); });
    return () => { live = false; };
  }, [scene, themeKey]);
  if (empty) return <p className="text-[0.7em] text-muted">An empty whiteboard</p>;
  if (!svg) return <div className="h-48 animate-pulse rounded-xl bg-fill" />;
  return <div role="img" aria-label="Whiteboard drawing" className="[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-h-[62vh] [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}
