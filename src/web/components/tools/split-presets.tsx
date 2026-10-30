/**
 * R74: Split PDF without typing. Once the PDF's pages are counted: Every page, Every N pages, Two halves, or Custom
 * (the ranges field as before). Under the choice, a live preview of the parts the run will make. Every choice fills
 * the same ranges text the tool always sent.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  SPLIT_EVERY, parseRanges, partLabel, presetFits, presetOf, presetParts, rangesOf, type Part, type SplitPreset,
} from "@/shared/split-presets";

const chip = (on: boolean) => `rounded-lg border px-3 py-1.5 text-sm max-sm:min-h-11 disabled:opacity-40 ${on ? "border-brand bg-brand/5 font-medium" : "border-line hover:bg-hover"}`;
const SHOW_PARTS = 8;

export function SplitPresets({ pages, value, onChange, disabled, custom }: {
  pages: number; value: string; onChange: (ranges: string) => void; disabled: boolean; custom: ReactNode;
}) {
  const start = useMemo(() => presetOf(value, pages), [pages]); // eslint-disable-line react-hooks/exhaustive-deps
  const [preset, setPreset] = useState<SplitPreset>(start.preset);
  const [n, setN] = useState<number>(start.n);
  // A new file: start again from what the field holds.
  useEffect(() => { const s = presetOf(value, pages); setPreset(s.preset); setN(s.n); }, [pages]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (p: SplitPreset, every = n) => {
    setPreset(p);
    setN(every);
    if (p !== "custom") onChange(rangesOf(presetParts(p, pages, every)));
  };
  const parsed = preset === "custom" ? parseRanges(value, pages) : { parts: presetParts(preset, pages, n), error: null };
  const parts: Part[] = parsed.parts;
  const fitsEvery = SPLIT_EVERY.filter((k) => k < pages && presetFits("every", pages, k));

  return (
    <div className="space-y-2" data-testid="split-presets">
      <div className="text-[13px] font-medium" id="split-presets-label">How to split</div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="split-presets-label">
        <button type="button" role="radio" aria-checked={preset === "each"} disabled={disabled || !presetFits("each", pages)} onClick={() => choose("each")} className={chip(preset === "each")} data-testid="split-each">Every page</button>
        {fitsEvery.length > 0 && (
          <button type="button" role="radio" aria-checked={preset === "every"} disabled={disabled} onClick={() => choose("every", fitsEvery.includes(n) ? n : fitsEvery[0])} className={chip(preset === "every")} data-testid="split-every">Every {preset === "every" ? n : fitsEvery.includes(n) ? n : fitsEvery[0]} pages</button>
        )}
        <button type="button" role="radio" aria-checked={preset === "halves"} disabled={disabled || pages < 2} onClick={() => choose("halves")} className={chip(preset === "halves")} data-testid="split-halves">Two halves</button>
        <button type="button" role="radio" aria-checked={preset === "custom"} disabled={disabled} onClick={() => choose("custom")} className={chip(preset === "custom")} data-testid="split-custom">Choose pages</button>
      </div>
      {preset === "every" && fitsEvery.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Pages in each part" data-testid="split-every-n">
          <span className="mr-1 text-[12.5px] text-muted">Pages in each part</span>
          {fitsEvery.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={n === k} disabled={disabled} onClick={() => choose("every", k)}
              className={`${chip(n === k)} min-w-11 px-2.5 tabular-nums`}>{k}</button>
          ))}
        </div>
      )}
      {preset === "custom" && custom}
      <div className="rounded-lg bg-fill px-3 py-2 text-[13px]" aria-live="polite" data-testid="split-preview">
        {parsed.error ? <span className="text-bad">{parsed.error}</span>
          : parts.length === 0 ? <span className="text-muted">Type the pages for each part, like 1-3, 5.</span>
            : (
              <>
                <span className="font-medium" data-testid="split-preview-count">{parts.length === 1 ? "1 PDF" : `${parts.length} PDFs`}</span>
                <span className="text-muted"> from {pages} {pages === 1 ? "page" : "pages"}: </span>
                <span className="text-muted">{parts.slice(0, SHOW_PARTS).map(partLabel).join("; ")}{parts.length > SHOW_PARTS ? `; and ${parts.length - SHOW_PARTS} more` : ""}.</span>
              </>
            )}
      </div>
    </div>
  );
}
