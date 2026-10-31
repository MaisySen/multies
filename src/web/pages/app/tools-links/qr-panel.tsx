/** R87: a QR code for any link: brand colour, the workspace mark in the middle, PNG or SVG in the size you need. */
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { useBranding } from "@/web/lib/brand";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { Switch } from "@/web/components/ui/misc";
import { IconDownload } from "@/web/components/ui/icon";

const SIZES = [256, 512, 1024, 2048];

function modulesPath(data: boolean[][]): string {
  let d = "";
  data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
  return d;
}

async function dataUrlOf(src: string): Promise<string | null> {
  try {
    const r = await fetch(src);
    if (!r.ok) return null;
    const b = await r.blob();
    return await new Promise((res) => { const f = new FileReader(); f.onload = () => res(String(f.result)); f.onerror = () => res(null); f.readAsDataURL(b); });
  } catch { return null; }
}

function download(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

export function QrPanel({ value, name }: { value: string; name: string }) {
  const brand = useBranding();
  const b = brand.data?.brand;
  const brandColor = b?.primary ?? b?.accent ?? null;
  const logoKind = b?.logos?.mark_light ? "mark_light" : b?.logos?.mark_dark ? "mark_dark" : null;
  const logoUrl = logoKind && brand.data ? `/api/branding/logo/${brand.data.orgId}/${logoKind}/${b!.logos[logoKind]}` : null;
  const [colorMode, setColorMode] = useState<"brand" | "black" | "custom">("black");
  const [custom, setCustom] = useState("#111111");
  const [logo, setLogo] = useState(false);
  const [size, setSize] = useState(1024);
  const [logoData, setLogoData] = useState<string | null>(null);
  useEffect(() => { if (brandColor) setColorMode("brand"); }, [brandColor]);
  useEffect(() => { if (logo && logoUrl && !logoData) void dataUrlOf(logoUrl).then(setLogoData); }, [logo, logoUrl, logoData]);
  const color = colorMode === "brand" && brandColor ? brandColor : colorMode === "custom" ? custom : "#111111";
  const withLogo = logo && !!logoData;
  const qr = useMemo(() => encode(value, { ecc: withLogo ? "H" : "M", border: 2 }), [value, withLogo]);
  const n = qr.size;
  const path = useMemo(() => modulesPath(qr.data), [qr]);
  const box = Math.round(n * 0.22);
  const at = (n - box) / 2;

  const svgText = () => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#ffffff"/><path d="${path}" fill="${color}"/>${withLogo ? `<rect x="${at - 0.5}" y="${at - 0.5}" width="${box + 1}" height="${box + 1}" rx="1" fill="#ffffff"/><image href="${logoData}" x="${at}" y="${at}" width="${box}" height="${box}" preserveAspectRatio="xMidYMid meet"/>` : ""}</svg>`;
  const saveSvg = () => download(URL.createObjectURL(new Blob([svgText()], { type: "image/svg+xml" })), `${name}-qr.svg`);
  const savePng = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const s = size / n;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = color;
    qr.data.forEach((row, y) => row.forEach((on, x) => { if (on) ctx.fillRect(Math.floor(x * s), Math.floor(y * s), Math.ceil(s), Math.ceil(s)); }));
    if (withLogo && logoData) {
      const img = new Image();
      await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); img.src = logoData; });
      ctx.fillStyle = "#ffffff"; ctx.fillRect((at - 0.5) * s, (at - 0.5) * s, (box + 1) * s, (box + 1) * s);
      ctx.drawImage(img, at * s, at * s, box * s, box * s);
    }
    download(canvas.toDataURL("image/png"), `${name}-qr.png`);
  };

  return (
    <div className="space-y-4" data-testid="qr-panel">
      <div className="mx-auto w-fit rounded-2xl border border-line bg-white p-3 shadow-card">
        <svg role="img" aria-label={`QR code for ${value}`} width={200} height={200} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
          <rect width={n} height={n} fill="#ffffff" />
          <path d={path} fill={color} />
          {withLogo && <><rect x={at - 0.5} y={at - 0.5} width={box + 1} height={box + 1} rx={1} fill="#ffffff" /><image href={logoData!} x={at} y={at} width={box} height={box} preserveAspectRatio="xMidYMid meet" /></>}
        </svg>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px] font-medium">Colour
          <div className="mt-1 flex gap-2">
            <Select value={colorMode} onChange={(e) => setColorMode(e.target.value as typeof colorMode)} className="flex-1" data-testid="qr-color">
              {brandColor && <option value="brand">Workspace brand</option>}
              <option value="black">Black</option>
              <option value="custom">Pick a colour</option>
            </Select>
            {colorMode === "custom" && <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="QR colour" className="h-9 w-11 cursor-pointer rounded-lg border border-line-strong bg-surface p-1 max-sm:h-11" />}
          </div>
        </label>
        <label className="block text-[13px] font-medium">Size
          <Select value={String(size)} onChange={(e) => setSize(Number(e.target.value))} className="mt-1" data-testid="qr-size">
            {SIZES.map((s) => <option key={s} value={s}>{s} by {s} px</option>)}
          </Select>
        </label>
      </div>
      <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
        <span className="text-[13px]"><span className="font-medium">Workspace logo in the middle</span><span className="block text-muted">{logoUrl ? "Uses stronger error correction so it still scans" : "Add a logo in Settings, Branding to use this"}</span></span>
        <Switch checked={logo} onChange={setLogo} label="Workspace logo in the middle" disabled={!logoUrl} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void savePng()} data-testid="qr-png"><IconDownload className="h-4 w-4" />PNG</Button>
        <Button variant="outline" onClick={saveSvg} data-testid="qr-svg"><IconDownload className="h-4 w-4" />SVG</Button>
      </div>
      {colorMode === "custom" && <p className="text-[12px] text-subtle">Pick a dark colour so phone cameras can read it.</p>}
    </div>
  );
}
