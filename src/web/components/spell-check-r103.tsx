/**
 * R103: the spelling button for Docs and Mail compose. Opens a small dialog: underline spelling on or off, the
 * language (20), and "Check spelling", which lists common typos with a fix each, "Fix all" and "Ignore".
 */
import { useMemo, useState } from "react";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { Switch } from "@/web/components/ui/misc";
import { IconCheck, IconText } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { SPELL_LANGUAGES, checkSpelling, isSpellLang, type SpellIssue } from "@/shared/docs-plus";
import { useSpellPref } from "@/web/lib/spell-r103";

export function SpellButton({ getText, onFix, className, compact }: {
  /** The text to check, read when the dialog opens. */
  getText: () => string;
  /** Replace every whole word `word` with `fix` in the source. */
  onFix: (fixes: { word: string; suggestion: string }[]) => void;
  className?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pref, setPref] = useSpellPref();
  const [text, setText] = useState("");
  const [done, setDone] = useState<string[]>([]);
  const issues = useMemo(() => {
    const all = checkSpelling(text, pref.lang, [...pref.ignore, ...done]);
    const seen = new Map<string, SpellIssue & { count: number }>();
    for (const i of all) { const k = `${i.word}>${i.suggestion}`; const s = seen.get(k); if (s) s.count += 1; else seen.set(k, { ...i, count: 1 }); }
    return [...seen.values()];
  }, [text, pref.lang, pref.ignore, done]);
  const english = pref.lang.startsWith("en-");
  const start = () => { setText(getText()); setDone([]); setOpen(true); };
  const fix = (list: { word: string; suggestion: string }[]) => { onFix(list); setDone((d) => [...d, ...list.map((x) => x.word.toLowerCase())]); };
  return (
    <>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={start} aria-label="Spelling" title="Spelling" data-testid="spell-button"
        className={cn("inline-flex shrink-0 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-muted transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-11 max-sm:min-w-11", className)}>
        <IconText className="h-4 w-4 max-sm:h-5 max-sm:w-5" />{!compact && <span className="max-lg:hidden">Spelling</span>}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Spelling" description="Your browser underlines words it does not know. Right click one for suggestions."
        footer={<Button variant="secondary" onClick={() => setOpen(false)}>Done</Button>}>
        <div className="space-y-4" data-testid="spell-dialog">
          <Switch checked={pref.on} onChange={(on) => setPref({ on })} label="Underline spelling as I type" />
          <label className="block text-[13px] font-medium">Language
            <Select value={pref.lang} onChange={(e) => { if (isSpellLang(e.target.value)) setPref({ lang: e.target.value }); }} className="mt-1" aria-label="Spelling language">
              {SPELL_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </Select>
          </label>
          <section aria-label="Common typos" className="rounded-lg border border-line">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <h3 className="text-[13px] font-semibold">Common typos</h3>
              {issues.length > 1 && <Button size="sm" variant="secondary" onClick={() => fix(issues)} data-testid="spell-fix-all">Fix all</Button>}
            </div>
            {!english ? <p className="px-3 py-3 text-[13px] text-muted">The typo list is for English. For this language, use the underlines and right click suggestions.</p>
              : !issues.length ? <p className="flex items-center gap-2 px-3 py-3 text-[13px] text-muted" role="status"><IconCheck className="h-4 w-4 text-[color:var(--success,#1f7a4d)]" />No common typos found.</p>
                : (
                  <ul className="max-h-64 divide-y divide-line overflow-y-auto" data-testid="spell-issues">
                    {issues.map((i) => (
                      <li key={`${i.word}>${i.suggestion}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[14px]">
                        <span className="min-w-0 flex-1"><s className="text-muted">{i.word}</s> <span aria-hidden>to</span> <strong>{i.suggestion}</strong>{i.count > 1 && <span className="text-[12px] text-subtle"> ({i.count} times)</span>}</span>
                        <Button size="sm" onClick={() => fix([i])} aria-label={`Fix ${i.word} to ${i.suggestion}`}>Fix</Button>
                        <Button size="sm" variant="ghost" onClick={() => setPref({ ignore: [...pref.ignore, i.word.toLowerCase()].slice(-500) })} aria-label={`Ignore ${i.word}`}>Ignore</Button>
                      </li>
                    ))}
                  </ul>
                )}
          </section>
        </div>
      </Dialog>
    </>
  );
}

/** Replace whole words in plain text (for a textarea). */
export function fixPlainText(text: string, fixes: { word: string; suggestion: string }[]): string {
  let s = text;
  for (const f of fixes) s = s.replace(new RegExp(`(^|[^A-Za-z'])${f.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z'])`, "g"), (_m, pre: string) => `${pre}${f.suggestion}`);
  return s;
}
