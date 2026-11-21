/**
 * OPS1: what an operator change did, as rows of field, before and after (audit log, config saves).
 * Usage: <JsonDiff before={row.before} after={row.after} />. Nested objects are flattened to dotted paths;
 * unchanged fields are left out unless showSame. Values that are not objects show as a single "value" row.
 */
import { cn } from "@/web/lib/cn";

type Flat = Record<string, unknown>;

export function flatten(v: unknown, prefix = "", out: Flat = {}): Flat {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length && prefix) out[prefix] = {};
    for (const [k, x] of entries) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = v;
  } else if (v !== undefined && v !== null) {
    out.value = v;
  }
  return out;
}

const show = (v: unknown) => (v === undefined ? "" : v === null ? "none" : typeof v === "string" ? v : JSON.stringify(v));

export function diffRows(before: unknown, after: unknown, showSame = false) {
  const a = flatten(before), b = flatten(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.map((k) => ({ key: k, before: a[k], after: b[k], same: JSON.stringify(a[k]) === JSON.stringify(b[k]) })).filter((r) => showSame || !r.same);
}

export function JsonDiff({ before, after, showSame, className }: { before: unknown; after: unknown; showSame?: boolean; className?: string }) {
  const rows = diffRows(before, after, showSame);
  if (!rows.length) return <p className={cn("text-xs text-subtle", className)}>No recorded change.</p>;
  return (
    <div className={cn("overflow-x-auto rounded-lg border border-line", className)}>
      <table className="w-full text-xs">
        <thead className="bg-fill/60 text-left text-muted"><tr><th className="px-3 py-1.5 font-medium">Field</th><th className="px-3 py-1.5 font-medium">Before</th><th className="px-3 py-1.5 font-medium">After</th></tr></thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="px-3 py-1.5 font-mono">{r.key}</td>
              <td className="px-3 py-1.5 font-mono text-bad [overflow-wrap:anywhere]">{show(r.before)}</td>
              <td className="px-3 py-1.5 font-mono text-ok [overflow-wrap:anywhere]">{show(r.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
