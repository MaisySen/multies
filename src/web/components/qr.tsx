import { useMemo } from "react";
import { encode } from "uqr";

/** Crisp SVG QR code. Dark modules on white so every phone camera reads it. */
export function QrCode({ value, size = 176, label }: { value: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
    return { path: d, n: qr.size };
  }, [value]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="rounded-lg bg-white">
      <path d={path} fill="#09090b" />
    </svg>
  );
}
