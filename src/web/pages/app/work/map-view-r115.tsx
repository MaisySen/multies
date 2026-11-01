/**
 * R115: the map itself, in its own lazy chunk (MapLibre GL JS, BSD 3 clause, with free OpenFreeMap tiles; no key).
 * Numbered pins, an optional dashed line through them in order, fits every pin in view. Light and dark styles follow
 * the app theme. If the tiles cannot load, the caller's text and links still work and this says so in plain words.
 */
import { useEffect, useId, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MAP_CREDITS } from "@/shared/maps-r115";

export interface MapPoint { lat: number; lon: number; label: string; n?: number }

const STYLE = (dark: boolean) => `https://tiles.openfreemap.org/styles/${dark ? "dark" : "positron"}`;
export function isDarkTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}
function brandColour(el: HTMLElement) {
  const probe = document.createElement("span");
  probe.className = "text-brand";
  el.appendChild(probe);
  const c = getComputedStyle(probe).color || "#3b5bdb";
  probe.remove();
  return c;
}

export function MapView({ points, line = false, className, label }: { points: MapPoint[]; line?: boolean; className?: string; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [credits, setCredits] = useState(false);
  const creditsId = useId();
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [failed, setFailed] = useState(false);
  const [dark, setDark] = useState(isDarkTheme);

  useEffect(() => {
    const obs = new MutationObserver(() => setDark(isDarkTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!box.current) return;
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({
        container: box.current, style: STYLE(dark), attributionControl: false, cooperativeGestures: true,
        center: points[0] ? [points[0].lon, points[0].lat] : [151.2093, -33.8688], zoom: 13, fadeDuration: 0,
      });
    } catch { setFailed(true); return; }
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    // Credits are our own small "i" button below (collapsed, underlined links, one line), not the library control.
    m.on("error", (e) => { if (!m.isStyleLoaded() && /style|Failed to fetch|NetworkError/i.test(String(e.error?.message ?? ""))) setFailed(true); });
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, [dark]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current, el = box.current;
    if (!m || !el) return;
    markers.current.forEach((x) => x.remove());
    markers.current = points.map((p) => {
      const pin = document.createElement("div");
      pin.className = "grid h-7 min-w-7 place-items-center rounded-full border-2 border-surface bg-brand px-1.5 text-[12px] font-semibold text-brand-fg shadow-card";
      pin.textContent = p.n ? String(p.n) : "";
      if (!p.n) pin.className = "h-4 w-4 rounded-full border-2 border-surface bg-brand shadow-card";
      pin.setAttribute("role", "img");
      pin.setAttribute("aria-label", p.n ? `Stop ${p.n}, ${p.label}` : p.label);
      return new maplibregl.Marker({ element: pin }).setLngLat([p.lon, p.lat]).addTo(m);
    });
    const draw = () => {
      const data = { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: points.map((p) => [p.lon, p.lat]) } };
      const src = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else if (line) {
        m.addSource("route", { type: "geojson", data });
        m.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": brandColour(el), "line-width": 3, "line-dasharray": [2, 1.5], "line-opacity": 0.85 } });
      }
      if (m.getLayer("route")) m.setLayoutProperty("route", "visibility", line && points.length > 1 ? "visible" : "none");
    };
    if (m.isStyleLoaded()) draw(); else m.once("load", draw);
    if (points.length === 1) m.jumpTo({ center: [points[0].lon, points[0].lat], zoom: 15 });
    else if (points.length > 1) {
      const b = new maplibregl.LngLatBounds();
      points.forEach((p) => b.extend([p.lon, p.lat]));
      m.fitBounds(b, { padding: 48, maxZoom: 15, duration: 0 });
    }
  }, [points, line, dark]);

  return (
    <div className={className} role="region" aria-label={label}>
      <div className="relative h-full w-full">
        <div ref={box} className="h-full w-full overflow-hidden rounded-xl border border-line bg-fill" data-testid="map" />
        <div className="absolute bottom-1.5 right-1.5 flex items-end gap-1">
          {credits && (
            <p id={creditsId} className="max-w-[260px] rounded-md border border-line bg-surface px-2 py-1 text-[11px] leading-snug text-muted shadow-card" data-testid="map-credits">
              {MAP_CREDITS.map((c, i) => (
                <span key={c.href}>{i > 0 && ", "}<a href={c.href} target="_blank" rel="noopener noreferrer" className="text-fg underline underline-offset-2">{c.label}</a></span>
              ))}
            </p>
          )}
          <button type="button" aria-label="Map credits" aria-expanded={credits} aria-controls={creditsId} onClick={() => setCredits((v) => !v)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line bg-surface text-[12px] font-semibold text-muted shadow-card hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">i</button>
        </div>
      </div>
      {failed && <p className="mt-1.5 text-[12.5px] text-muted" role="status">The map could not load. The address and directions still work.</p>}
    </div>
  );
}
