/**
 * Tools P2 (18, flag autoredact): "Find and hide sensitive info". Runs pii-find on a PDF (an upload or a mail
 * attachment), lists what it found grouped by kind with every item ticked, then burns the ticked ones through the
 * existing redact op (phrases), which checks afterwards that none can be found. Nothing is burned without review.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { IconDownload, IconMail, IconShieldCheck } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Badge, Card } from "@/web/components/ui/misc";
import { PII_KINDS, toolDef, type PiiMatch, type ToolDef, type ToolJob } from "@/shared/tools";
import { attachmentJob, jobFailure, jobText, uploadJob, waitForJob } from "@/web/lib/tool-jobs";
import { attachToNewEmail } from "@/web/lib/compose-files"; // Tools P2: the one "Attach to a new email" path
import { resultLine, sizeOf } from "./tool-fields";

type Phase =
  | { kind: "idle" }
  | { kind: "finding"; step: string }
  | { kind: "review"; matches: PiiMatch[] }
  | { kind: "burning"; step: string; matches: PiiMatch[] }
  | { kind: "done"; job: ToolJob }
  | { kind: "failed"; message: string };

const LABEL: Record<string, string> = Object.fromEntries(PII_KINDS.map((k) => [k.kind, k.label]));
/** The redact op takes up to this many characters of phrases (catalogue maxLen). */
const PHRASES_MAX = toolDef("redact").options.find((o) => o.name === "phrases")?.maxLen ?? 2000;

/** Reads pii-find's JSON: {"matches":[{"kind","text","page","rect"}]}. Bad rows are dropped. */
export function parseMatches(raw: string): PiiMatch[] {
  try {
    const v = JSON.parse(raw) as { matches?: unknown };
    if (!Array.isArray(v.matches)) return [];
    return v.matches.filter((m): m is PiiMatch => !!m && typeof (m as PiiMatch).text === "string" && (m as PiiMatch).text.trim() !== "" && typeof (m as PiiMatch).kind === "string")
      .map((m) => ({ kind: m.kind, text: m.text.trim().slice(0, 200), page: Number(m.page) || 0 }));
  } catch { return []; }
}

/** Matches grouped by kind, in the order people expect (tax numbers first), same text on the same page counted once. */
export function groupMatches(matches: PiiMatch[]): { kind: string; label: string; items: (PiiMatch & { key: string })[] }[] {
  const order = [...PII_KINDS.map((k) => k.kind as string), ...new Set(matches.map((m) => m.kind))];
  const seen = new Set<string>();
  const out: { kind: string; label: string; items: (PiiMatch & { key: string })[] }[] = [];
  for (const kind of [...new Set(order)]) {
    const items = matches.filter((m) => m.kind === kind).map((m) => ({ ...m, key: `${m.kind}|${m.text}|${m.page}` })).filter((m) => (seen.has(m.key) ? false : (seen.add(m.key), true)));
    if (items.length) out.push({ kind, label: LABEL[kind] ?? "Other", items });
  }
  return out;
}

/** The phrases to burn: each ticked text once, one per line. */
export function phrasesFor(matches: PiiMatch[], ticked: Set<string>): string {
  const texts = new Set<string>();
  for (const m of matches) if (ticked.has(`${m.kind}|${m.text}|${m.page}`)) texts.add(m.text);
  return [...texts].join("\n");
}

const mask = (t: string) => (t.length <= 4 ? t : `${t.slice(0, Math.max(2, t.length - 6))}${"•".repeat(Math.min(6, t.length - 2))}`);

export function AutoRedactPanel({ tool, fromMail, file, disabled, onUsage }: { tool: ToolDef; fromMail: { id: string; name: string } | null; file: File | null; disabled: boolean; onUsage?: () => void }) {
  const navigate = useNavigate();
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(PII_KINDS.map((k) => k.kind)));
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [reveal, setReveal] = useState(false);
  const matches = useMemo(() => (phase.kind === "review" || phase.kind === "burning" ? phase.matches : []), [phase]);
  const groups = useMemo(() => groupMatches(matches), [matches]);
  const phrases = phrasesFor(matches, ticked);
  const busy = phase.kind === "finding" || phase.kind === "burning";

  const runOn = async (op: "pii-find" | "redact", options: Record<string, string>, step: (s: string) => void) => {
    const job = fromMail ? await attachmentJob(op, [fromMail.id], options) : await uploadJob(op, [file!], options, (pct) => step(pct < 100 ? `Uploading ${pct}%` : "Working on it"));
    step("Working on it");
    const done = await waitForJob(job.token);
    onUsage?.();
    if (done.status !== "done") throw new Error(jobFailure(done));
    return done;
  };

  const find = async () => {
    setPhase({ kind: "finding", step: "Starting" });
    try {
      const job = await runOn("pii-find", { kinds: JSON.stringify([...kinds]) }, (s) => setPhase({ kind: "finding", step: s }));
      const found = parseMatches(await jobText(job));
      setTicked(new Set(groupMatches(found).flatMap((g) => g.items.map((m) => m.key))));
      setPhase({ kind: "review", matches: found });
    } catch (err) { setPhase({ kind: "failed", message: (err as Error).message }); }
  };

  const burn = async () => {
    if (phase.kind !== "review" || !phrases) return;
    const keep = phase.matches;
    setPhase({ kind: "burning", step: "Starting", matches: keep });
    try {
      const job = await runOn("redact", { phrases }, (s) => setPhase({ kind: "burning", step: s, matches: keep }));
      setPhase({ kind: "done", job });
    } catch (err) { setPhase({ kind: "failed", message: (err as Error).message }); }
  };

  const toggle = (key: string) => setTicked((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleGroup = (keys: string[], on: boolean) => setTicked((cur) => { const n = new Set(cur); for (const k of keys) { if (on) n.add(k); else n.delete(k); } return n; });

  if (phase.kind === "done") {
    const j = phase.job;
    return (
      <div className="space-y-3" data-testid="autoredact-done">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#34C759] text-white [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden><IconShieldCheck /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{j.name}</div>
            {resultLine(j) && <div className="text-[13px]" data-testid="autoredact-facts">{resultLine(j)}</div>}
            <div className="text-[12.5px] text-muted">{j.bytes ? sizeOf(j.bytes) : "Ready"}. Download within an hour.</div>
          </div>
          {j.downloadUrl && <a href={j.downloadUrl} download={j.name} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg hover:opacity-90" data-testid="autoredact-download"><IconDownload className="h-4 w-4" aria-hidden />Download</a>}
          <Button type="button" variant="secondary" onClick={() => attachToNewEmail(navigate, { jobs: [j] })}><IconMail className="h-4 w-4" aria-hidden />Attach to a new email</Button>
          <Button type="button" variant="ghost" onClick={() => setPhase({ kind: "idle" })}>Start again</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="autoredact">
      {(phase.kind === "idle" || phase.kind === "finding" || phase.kind === "failed") && (
        <>
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium">Look for</legend>
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {PII_KINDS.map((k) => (
                <label key={k.kind} className="flex items-center gap-2 text-sm max-sm:min-h-11">
                  <input type="checkbox" className="h-4 w-4 accent-[#0071E3]" checked={kinds.has(k.kind)} disabled={busy}
                    onChange={(e) => setKinds((cur) => { const n = new Set(cur); if (e.target.checked) n.add(k.kind); else n.delete(k.kind); return n; })} data-testid={`autoredact-kind-${k.kind}`} />
                  {k.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={find} disabled={disabled || busy || kinds.size === 0} data-testid="autoredact-find">Find sensitive info</Button>
            {phase.kind === "finding" && <span className="text-sm text-muted" role="status">{phase.step}</span>}
          </div>
        </>
      )}

      {phase.kind === "failed" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3" role="alert" data-testid="autoredact-error">
          <Badge tone="bad">Didn't work</Badge><p className="min-w-0 flex-1 text-sm">{phase.message}</p>
        </div>
      )}

      {(phase.kind === "review" || phase.kind === "burning") && (
        groups.length === 0 ? (
          <div className="space-y-3 rounded-xl border border-line p-4" data-testid="autoredact-none">
            <p className="text-sm"><span className="font-medium">Nothing found.</span> No numbers or addresses of the kinds you picked are in this PDF's text. Scanned pages need Make searchable first.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => navigate(fromMail ? `/app/tools?op=redact&attachment=${encodeURIComponent(fromMail.id)}&name=${encodeURIComponent(fromMail.name)}` : "/app/tools?op=redact")}>Type words to black out</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPhase({ kind: "idle" })}>Look again</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3" data-testid="autoredact-review">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm"><span className="font-medium">Found {matches.length === 1 ? "1 item" : `${groups.reduce((n, g) => n + g.items.length, 0)} items`}.</span> Untick anything that should stay.</p>
              <button type="button" className="text-[13px] text-brand hover:underline" onClick={() => setReveal((r) => !r)}>{reveal ? "Hide the numbers" : "Show the numbers"}</button>
            </div>
            {groups.map((g) => {
              const keys = g.items.map((m) => m.key);
              const on = keys.filter((k) => ticked.has(k)).length;
              return (
                <Card key={g.kind} className="overflow-hidden p-0" data-testid={`autoredact-group-${g.kind}`}>
                  <label className="flex items-center gap-3 border-b border-line bg-surface px-3 py-2 text-sm font-medium max-sm:min-h-11">
                    <input type="checkbox" className="h-4 w-4 accent-[#0071E3]" checked={on === keys.length} disabled={busy}
                      ref={(el) => { if (el) el.indeterminate = on > 0 && on < keys.length; }} onChange={(e) => toggleGroup(keys, e.target.checked)} aria-label={`All ${g.label.toLowerCase()}`} />
                    <span className="flex-1">{g.label}</span>
                    <span className="text-[12.5px] font-normal text-muted tabular-nums">{on} of {keys.length}</span>
                  </label>
                  <ul className="divide-y divide-line">
                    {g.items.map((m) => (
                      <li key={m.key}>
                        <label className="flex items-center gap-3 px-3 py-2 text-sm max-sm:min-h-11">
                          <input type="checkbox" className="h-4 w-4 accent-[#0071E3]" checked={ticked.has(m.key)} disabled={busy} onChange={() => toggle(m.key)} />
                          <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{reveal ? m.text : mask(m.text)}</span>
                          {m.page > 0 && <span className="shrink-0 text-[12.5px] text-muted">Page {m.page}</span>}
                        </label>
                      </li>
                    ))}
                  </ul>
                </Card>
              );
            })}
            {phrases.length > PHRASES_MAX && <p className="text-[13px] text-danger" role="alert">That is too many to black out in one go. Untick some, run it, then run the result again.</p>}
            <p className="text-[12.5px] text-muted">{tool.note} The whole line holding each item is blacked out, and those pages become images.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={burn} disabled={busy || !phrases || phrases.length > PHRASES_MAX} data-testid="autoredact-burn">
                Black out {ticked.size === 1 ? "1 item" : `${ticked.size} items`}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setPhase({ kind: "idle" })}>Cancel</Button>
              {phase.kind === "burning" && <span className="text-sm text-muted" role="status">{phase.step}</span>}
            </div>
          </div>
        )
      )}
    </div>
  );
}
