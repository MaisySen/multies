/** R126 People: the asset form, and the QR label helpers (drawn from our own code with uqr: no third party, no network). */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { encode } from "uqr";
import { api, errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { DateInput, Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { ASSET_KINDS, ASSET_KIND_LABEL, ASSET_STATUSES, ASSET_STATUS_LABEL, type Asset, type AssetKind, type AssetStatus } from "@/shared/people-r126";
import { pk } from "./model";

type Form = { name: string; kind: AssetKind; serial: string; purchaseDate: string; warrantyEnd: string; value: string; notes: string; status: AssetStatus };
const blank: Form = { name: "", kind: "laptop", serial: "", purchaseDate: "", warrantyEnd: "", value: "", notes: "", status: "in_stock" };

export function AssetFormDialog({ open, onClose, asset, onSaved }: { open: boolean; onClose: () => void; asset?: Asset; onSaved?: (a: Asset) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(blank);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setF(asset ? { name: asset.name, kind: asset.kind, serial: asset.serial, purchaseDate: asset.purchaseDate ?? "", warrantyEnd: asset.warrantyEnd ?? "",
      value: asset.valueCents == null ? "" : (asset.valueCents / 100).toFixed(2), notes: asset.notes, status: asset.status } : blank);
  }, [open, asset]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!f.name.trim()) { setErr("Give the asset a name."); return; }
    const v = f.value.trim() ? Math.round(Number(f.value.replace(/[, ]/g, "")) * 100) : null;
    if (v !== null && (!Number.isFinite(v) || v < 0)) { setErr("Value must be a positive amount."); return; }
    setBusy(true); setErr(null);
    const body = { name: f.name, kind: f.kind, serial: f.serial, purchaseDate: f.purchaseDate || null, warrantyEnd: f.warrantyEnd || null, valueCents: v, notes: f.notes, ...(asset ? { status: f.status } : {}) };
    try {
      const r = asset ? await api.patch<{ asset: Asset }>(`/people/assets/${encodeURIComponent(asset.id)}`, body) : await api.create<{ asset: Asset }>("/people/assets", body);
      await qc.invalidateQueries({ queryKey: pk.assets });
      if (asset) await qc.invalidateQueries({ queryKey: pk.asset(asset.id) });
      toast.success(asset ? "Asset saved" : `Asset ${r.asset.tag} added`);
      onClose(); onSaved?.(r.asset);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={asset ? `Edit ${asset.tag}` : "New asset"} description={asset ? undefined : "It gets the next tag and a QR label you can print."}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy} data-testid="asset-save">{asset ? "Save" : "Add asset"}</Button></>}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Name" className="sm:col-span-2" error={err ?? undefined}>{(p) => <Input {...p} value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={100} placeholder="MacBook Air 13" data-testid="asset-name" autoFocus />}</Field>
        <Field label="Type">{(p) => <Select {...p} value={f.kind} onChange={(e) => set("kind", e.target.value as AssetKind)} data-testid="asset-kind">{ASSET_KINDS.map((k) => <option key={k} value={k}>{ASSET_KIND_LABEL[k]}</option>)}</Select>}</Field>
        <Field label="Serial number">{(p) => <Input {...p} value={f.serial} onChange={(e) => set("serial", e.target.value)} maxLength={80} />}</Field>
        <Field label="Purchase date">{(p) => <DateInput {...p} value={f.purchaseDate} onChange={(e) => set("purchaseDate", e.target.value)} />}</Field>
        <Field label="Warranty end">{(p) => <DateInput {...p} value={f.warrantyEnd} onChange={(e) => set("warrantyEnd", e.target.value)} data-testid="asset-warranty" />}</Field>
        <Field label="Value" hint="In your workspace currency">{(p) => <Input {...p} inputMode="decimal" value={f.value} onChange={(e) => set("value", e.target.value)} placeholder="0.00" />}</Field>
        {asset && <Field label="Status">{(p) => <Select {...p} value={f.status} onChange={(e) => set("status", e.target.value as AssetStatus)}>{ASSET_STATUSES.map((s) => <option key={s} value={s}>{ASSET_STATUS_LABEL[s]}</option>)}</Select>}</Field>}
        <Field label="Notes" className="sm:col-span-2">{(p) => <Textarea {...p} value={f.notes} onChange={(e) => set("notes", e.target.value)} maxLength={1000} rows={3} />}</Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/** QR module matrix for a link, the same encoder the app already uses for sign in codes. */
export function qrMatrix(value: string) { const q = encode(value, { ecc: "M", border: 2 }); return { data: q.data, n: q.size }; }

export function qrSvgString(value: string, label: string): string {
  const { data, n } = qrMatrix(value);
  let d = "";
  data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
  const esc = label.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n + 4}" width="${(n) * 8}" height="${(n + 4) * 8}" shape-rendering="crispEdges"><rect width="${n}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#09090b"/><text x="${n / 2}" y="${n + 2.6}" font-family="sans-serif" font-size="2.2" text-anchor="middle" fill="#09090b">${esc}</text></svg>`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function downloadSvg(value: string, label: string, file: string) { download(new Blob([qrSvgString(value, label)], { type: "image/svg+xml" }), file); }

/** PNG drawn straight onto a canvas from the module matrix (no image load, so no extra page policy is needed). */
export function downloadPng(value: string, label: string, file: string) {
  const { data, n } = qrMatrix(value);
  const s = 12; const c = document.createElement("canvas");
  c.width = n * s; c.height = (n + 4) * s;
  const g = c.getContext("2d"); if (!g) return;
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#09090b";
  data.forEach((row, y) => row.forEach((on, x) => { if (on) g.fillRect(x * s, y * s, s, s); }));
  g.font = `${Math.round(s * 2.2)}px sans-serif`; g.textAlign = "center"; g.fillText(label, c.width / 2, (n + 2.8) * s);
  c.toBlob((b) => { if (b) download(b, file); }, "image/png");
}
