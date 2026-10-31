/**
 * R100 Tools C: everyday utilities (/app/tools/utilities and /app/tools/utilities/:id). Everything runs on the device;
 * nothing typed here leaves the browser. Input on the left and the answer on the right at 1280, stacked on phones;
 * every answer has a Copy button with the Copied toast; Ctrl Enter runs where there is a run step.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { CopyButton } from "@/web/components/ui/misc";
import { QrCode } from "@/web/components/qr";
import { NotFound } from "@/web/pages/not-found";
import {
  HASH_ALGOS, UNIT_GROUPS, UtilError, base64ToUtf8, colourFormats, contrast, convertData, convertUnit, diffLines, diffStats,
  hash, minifyJson, parseColour, parseTime, testRegex, tidy, timeFormats, utf8ToBase64, uuidInfo, uuidV4, uuidV7, type DataFormat, type HashAlgo,
} from "@/shared/utilities";

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const mono = "font-mono text-[13px] leading-relaxed";

export interface UtilityDef { id: string; name: string; line: string; words: string }
export const UTILITIES: UtilityDef[] = [
  { id: "data", name: "JSON, YAML and CSV", line: "Tidy, check and convert data", words: "json yaml csv format pretty minify validate convert" },
  { id: "base64", name: "Base64", line: "Encode and decode text", words: "base64 encode decode" },
  { id: "hash", name: "Hash", line: "SHA 256, SHA 1, MD5 of text or a file", words: "hash checksum sha md5 sha256" },
  { id: "uuid", name: "UUID", line: "Make ids, read their version and time", words: "uuid guid id v4 v7" },
  { id: "qr", name: "QR code", line: "Make a QR code for a link or text", words: "qr code link scan" },
  { id: "colour", name: "Colour", line: "Pick a colour, convert it, check contrast", words: "colour color hex rgb hsl contrast picker" },
  { id: "units", name: "Units", line: "Length, weight, temperature and more", words: "units convert length weight temperature metres feet" },
  { id: "time", name: "Timestamps", line: "Unix time to a date and back", words: "time timestamp unix epoch date" },
  { id: "diff", name: "Text diff", line: "See what changed between two texts", words: "diff compare text changes" },
  { id: "regex", name: "Regex tester", line: "Test a pattern and see every match", words: "regex regular expression pattern match" },
];

/** Runs a function and keeps its error as a plain sentence for under the input. */
function attempt<T>(fn: () => T): { value: T | null; error: string | null } {
  try { return { value: fn(), error: null }; } catch (e) { return { value: null, error: e instanceof UtilError || e instanceof Error ? e.message : "That did not work." }; }
}

function Pane({ label, children, actions, id }: { label: string; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section className="min-w-0 space-y-2 rounded-2xl border border-line bg-surface p-3 sm:p-4" aria-labelledby={id}>
      <div className="flex min-h-8 items-center justify-between gap-2"><h2 id={id} className="text-[13px] font-semibold text-muted">{label}</h2><div className="flex items-center gap-2">{actions}</div></div>
      {children}
    </section>
  );
}

function ErrorLine({ text, testId = "util-error" }: { text: string | null; testId?: string }) {
  return text ? <p role="alert" className="text-[13px] text-bad" data-testid={testId}>{text}</p> : null;
}

function Output({ value, testId = "util-output", rows = 12 }: { value: string; testId?: string; rows?: number }) {
  return <Textarea readOnly value={value} rows={rows} aria-label="Result" className={`${mono} min-h-40 w-full bg-fill/40`} data-testid={testId} />;
}

function Two({ left, right }: { left: ReactNode; right: ReactNode }) {
  return <div className="grid gap-4 lg:grid-cols-2">{left}{right}</div>;
}

/* ---------------- each utility ---------------- */

function DataTool() {
  const [text, setText] = useState('{"name":"Multies","tools":["convert","fix"]}');
  const [from, setFrom] = useState<DataFormat>("json");
  const [to, setTo] = useState<DataFormat>("yaml");
  const [mini, setMini] = useState(false);
  const r = useMemo(() => attempt(() => (mini && to === "json" ? minifyJson(from === "json" ? text : convertData(text, from, "json")) : convertData(text, from, to))), [text, from, to, mini]);
  const fmt = (v: string) => v as DataFormat;
  return (
    <Two
      left={<Pane label="Input" id="util-in" actions={<Select aria-label="Input format" value={from} onChange={(e) => setFrom(fmt(e.target.value))} data-testid="data-from"><option value="json">JSON</option><option value="yaml">YAML</option><option value="csv">CSV</option></Select>}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} spellCheck={false} aria-label="Data to convert" className={`${mono} min-h-40 w-full`} data-testid="data-input" />
        <ErrorLine text={r.error} />
      </Pane>}
      right={<Pane label="Result" id="util-out" actions={<>
        <Select aria-label="Result format" value={to} onChange={(e) => setTo(fmt(e.target.value))} data-testid="data-to"><option value="json">JSON</option><option value="yaml">YAML</option><option value="csv">CSV</option></Select>
        {to === "json" && <label className="flex min-h-11 items-center gap-1.5 text-[13px] text-muted sm:min-h-0"><input type="checkbox" checked={mini} onChange={(e) => setMini(e.target.checked)} className={ring} />One line</label>}
        <CopyButton value={r.value ?? ""} toastText="Copied" />
      </>}><Output value={r.value ?? ""} /></Pane>}
    />
  );
}

function Base64Tool() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"encode" | "decode">("encode");
  const [urlSafe, setUrlSafe] = useState(false);
  const r = useMemo(() => (text ? attempt(() => (mode === "encode" ? utf8ToBase64(text, urlSafe) : base64ToUtf8(text))) : { value: "", error: null }), [text, mode, urlSafe]);
  return (
    <Two
      left={<Pane label={mode === "encode" ? "Text" : "Base64"} id="util-in" actions={<div role="group" aria-label="Direction" className="flex rounded-lg bg-fill p-0.5">
        {(["encode", "decode"] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`h-8 rounded-md px-3 text-[13px] max-sm:h-11 ${mode === m ? "bg-surface font-medium shadow-sm" : "text-muted"} ${ring}`} data-testid={`b64-${m}`}>{m === "encode" ? "Encode" : "Decode"}</button>)}
      </div>}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false} aria-label={mode === "encode" ? "Text to encode" : "Base64 to decode"} className={`${mono} min-h-40 w-full`} data-testid="b64-input" placeholder={mode === "encode" ? "Type or paste text" : "Paste Base64"} />
        {mode === "encode" && <label className="flex min-h-11 items-center gap-1.5 text-[13px] text-muted sm:min-h-0"><input type="checkbox" checked={urlSafe} onChange={(e) => setUrlSafe(e.target.checked)} className={ring} />Safe for links</label>}
        <ErrorLine text={r.error} />
      </Pane>}
      right={<Pane label="Result" id="util-out" actions={<CopyButton value={r.value ?? ""} toastText="Copied" />}><Output value={r.value ?? ""} rows={10} /></Pane>}
    />
  );
}

function HashTool() {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [out, setOut] = useState<Partial<Record<HashAlgo, string>>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      setError(null);
      if (!file && !text) { setOut({}); return; }
      if (file && file.size > 200 * 1024 * 1024) { setError("Files up to 200 MB can be hashed here."); setOut({}); return; }
      const data = file ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(text);
      const res: Partial<Record<HashAlgo, string>> = {};
      for (const a of HASH_ALGOS) res[a] = await hash(a, data);
      if (live) setOut(res);
    })().catch(() => live && setError("That file could not be read."));
    return () => { live = false; };
  }, [text, file]);
  return (
    <Two
      left={<Pane label="Text or file" id="util-in">
        <Textarea value={text} onChange={(e) => { setText(e.target.value); setFile(null); }} rows={8} aria-label="Text to hash" className={`${mono} w-full`} data-testid="hash-input" placeholder="Type or paste text" disabled={!!file} />
        <div className="flex flex-wrap items-center gap-2">
          <label className={`inline-flex h-10 cursor-pointer items-center rounded-lg border border-line-strong px-3 text-[13px] font-medium hover:bg-hover max-sm:h-11 ${ring}`}>
            Choose a file<input type="file" className="sr-only" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; setFile(f); }} data-testid="hash-file" />
          </label>
          {file && <span className="min-w-0 truncate text-[13px] text-muted">{file.name}<Button type="button" variant="ghost" size="sm" className="ml-1" onClick={() => setFile(null)}>Clear</Button></span>}
        </div>
        <ErrorLine text={error} />
      </Pane>}
      right={<Pane label="Hashes" id="util-out">
        <dl className="space-y-2" data-testid="hash-list">
          {HASH_ALGOS.map((a) => (
            <div key={a} className="rounded-lg bg-fill/50 p-2.5">
              <div className="flex items-center justify-between gap-2"><dt className="text-[12.5px] font-medium text-muted">{a}{a === "MD5" || a === "SHA-1" ? <span className="ml-1.5 font-normal text-subtle">for checksums only</span> : null}</dt>{out[a] && <CopyButton value={out[a]!} toastText="Copied" />}</div>
              <dd className={`${mono} mt-1 break-all`} data-testid={`hash-${a}`}>{out[a] ?? <span className="text-subtle">Waiting for text or a file</span>}</dd>
            </div>
          ))}
        </dl>
      </Pane>}
    />
  );
}

function UuidTool() {
  const [version, setVersion] = useState<"4" | "7">("4");
  const [count, setCount] = useState(5);
  const make = () => Array.from({ length: count }, () => (version === "4" ? uuidV4() : uuidV7()));
  const [ids, setIds] = useState<string[]>(() => Array.from({ length: 5 }, () => uuidV4()));
  const [check, setCheck] = useState("");
  const info = check ? attempt(() => uuidInfo(check)) : null;
  return (
    <Two
      left={<Pane label="Make ids" id="util-in" actions={<CopyButton value={ids.join("\n")} label="Copy all" toastText="Copied" />}>
        <div className="flex flex-wrap items-end gap-2">
          <Select aria-label="Kind" value={version} onChange={(e) => setVersion(e.target.value as "4" | "7")} data-testid="uuid-version"><option value="4">Random (v4)</option><option value="7">Time ordered (v7)</option></Select>
          <Select aria-label="How many" value={String(count)} onChange={(e) => setCount(Number(e.target.value))}>{[1, 5, 10, 50].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
          <Button type="button" onClick={() => setIds(make())} data-testid="uuid-make">Make new</Button>
        </div>
        <Output value={ids.join("\n")} rows={8} testId="uuid-output" />
      </Pane>}
      right={<Pane label="Read an id" id="util-out">
        <Input value={check} onChange={(e) => setCheck(e.target.value)} aria-label="UUID to read" placeholder="Paste a UUID" className={mono} data-testid="uuid-check" />
        <ErrorLine text={info?.error ?? null} />
        {info?.value && <p className="text-[14px]" data-testid="uuid-info">Version {info.value.version}{info.value.time ? `, made ${info.value.time.toLocaleString("en-AU")}` : ""}</p>}
      </Pane>}
    />
  );
}

function QrTool() {
  const [text, setText] = useState("https://multies.si");
  const svgRef = useRef<HTMLDivElement>(null);
  const tooLong = new TextEncoder().encode(text).length > 1200;
  const download = () => {
    const svg = svgRef.current?.querySelector("svg"); if (!svg) return;
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "qr-code.svg"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return (
    <Two
      left={<Pane label="Link or text" id="util-in">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} aria-label="Link or text for the QR code" className="w-full" data-testid="qr-input" />
        <ErrorLine text={!text ? "Type a link or some text." : tooLong ? "That is too long for a QR code that phones can read. Keep it under 1,200 characters." : null} />
      </Pane>}
      right={<Pane label="QR code" id="util-out" actions={text && !tooLong ? <Button type="button" variant="secondary" size="sm" onClick={download} data-testid="qr-download">Download</Button> : null}>
        <div ref={svgRef} className="grid place-items-center py-2" data-testid="qr-preview">{text && !tooLong ? <QrCode value={text} size={208} label={`QR code for ${text.slice(0, 60)}`} /> : <div className="grid h-52 w-52 place-items-center rounded-lg bg-fill text-[13px] text-subtle">No code yet</div>}</div>
      </Pane>}
    />
  );
}

function ColourTool() {
  const [text, setText] = useState("#1a73e8");
  const [bg, setBg] = useState("#ffffff");
  const c = attempt(() => parseColour(text));
  const b = attempt(() => parseColour(bg));
  const f = c.value ? colourFormats(c.value) : null;
  const ratio = c.value && b.value ? contrast(c.value, b.value) : null;
  return (
    <Two
      left={<Pane label="Colour" id="util-in">
        <div className="flex items-center gap-2">
          <input type="color" aria-label="Pick a colour" value={f ? f.hex.slice(0, 7) : "#000000"} onChange={(e) => setText(e.target.value)} className={`h-11 w-14 shrink-0 cursor-pointer rounded-lg border border-line-strong bg-surface ${ring}`} data-testid="colour-picker" />
          <Input value={text} onChange={(e) => setText(e.target.value)} aria-label="Colour as text" className={mono} data-testid="colour-input" />
        </div>
        <ErrorLine text={c.error} />
        {f && <dl className="space-y-2" data-testid="colour-formats">{(["hex", "rgb", "hsl"] as const).map((k) => <div key={k} className="flex items-center justify-between gap-2 rounded-lg bg-fill/50 px-2.5 py-2"><dt className="w-10 text-[12.5px] font-medium uppercase text-muted">{k}</dt><dd className={`${mono} min-w-0 flex-1 truncate`}>{f[k]}</dd><CopyButton value={f[k]} toastText="Copied" /></div>)}</dl>}
      </Pane>}
      right={<Pane label="Contrast" id="util-out">
        <Input value={bg} onChange={(e) => setBg(e.target.value)} aria-label="Background colour" className={mono} data-testid="colour-bg" />
        <ErrorLine text={b.error} testId="colour-bg-error" />
        {c.value && b.value && ratio !== null && (
          <div className="space-y-2">
            <div className="rounded-xl border border-line p-4 text-[15px] font-medium" style={{ color: f!.hex, background: colourFormats(b.value).hex }}>The quick brown fox</div>
            <p className="text-[14px]" data-testid="colour-ratio"><span className="font-semibold tabular-nums">{ratio}:1</span> <span className="text-muted">{ratio >= 7 ? "Passes AA and AAA" : ratio >= 4.5 ? "Passes AA for text" : ratio >= 3 ? "Passes AA for large text only" : "Too low for text"}</span></p>
          </div>
        )}
      </Pane>}
    />
  );
}

function UnitsTool() {
  const [group, setGroup] = useState("length");
  const units = UNIT_GROUPS[group].units;
  const [from, setFrom] = useState(units[2].id);
  const [to, setTo] = useState(units[5].id);
  const [value, setValue] = useState("1");
  useEffect(() => { const u = UNIT_GROUPS[group].units; setFrom(u[0].id); setTo(u[1].id); }, [group]);
  const r = value.trim() ? attempt(() => tidy(convertUnit(Number(value), group, from, to))) : { value: "", error: null };
  return (
    <Pane label="Convert" id="util-in">
      <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
        <Select aria-label="What to convert" value={group} onChange={(e) => setGroup(e.target.value)} data-testid="units-group">{Object.entries(UNIT_GROUPS).map(([k, g]) => <option key={k} value={k}>{g.label}</option>)}</Select>
        <div className="grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
          <div className="flex gap-2"><Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value" data-testid="units-value" className="tabular-nums" /><Select aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="units-from">{units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</Select></div>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setFrom(to); setTo(from); }} aria-label="Swap units">Swap</Button>
          <div className="flex items-center gap-2"><output className="min-h-10 flex-1 rounded-lg bg-fill/50 px-3 py-2 text-[15px] font-semibold tabular-nums" data-testid="units-result" aria-live="polite">{r.value}</output><Select aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} data-testid="units-to">{units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</Select></div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2"><ErrorLine text={r.error} />{r.value ? <CopyButton value={r.value} toastText="Copied" /> : null}</div>
    </Pane>
  );
}

function TimeTool() {
  const [text, setText] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [utc, setUtc] = useState(false);
  const r = attempt(() => timeFormats(parseTime(text), utc ? "UTC" : undefined));
  const rows: [string, string][] = r.value ? [["Unix seconds", r.value.unix], ["Milliseconds", r.value.ms], ["ISO 8601", r.value.iso], [utc ? "UTC" : "Your time", r.value.local], ["Relative", r.value.relative]] : [];
  return (
    <Two
      left={<Pane label="Unix time or date" id="util-in" actions={<Button type="button" variant="ghost" size="sm" onClick={() => setText(String(Math.floor(Date.now() / 1000)))}>Now</Button>}>
        <Input value={text} onChange={(e) => setText(e.target.value)} aria-label="Unix time or date" className={mono} data-testid="time-input" />
        <label className="flex min-h-11 items-center gap-1.5 text-[13px] text-muted sm:min-h-0"><input type="checkbox" checked={utc} onChange={(e) => setUtc(e.target.checked)} className={ring} />Show in UTC</label>
        <ErrorLine text={r.error} />
      </Pane>}
      right={<Pane label="Result" id="util-out"><dl className="space-y-2" data-testid="time-out">{rows.map(([k, v]) => <div key={k} className="flex items-center gap-2 rounded-lg bg-fill/50 px-2.5 py-2"><dt className="w-28 shrink-0 text-[12.5px] font-medium text-muted">{k}</dt><dd className={`${mono} min-w-0 flex-1 break-words`}>{v}</dd><CopyButton value={v} toastText="Copied" /></div>)}</dl></Pane>}
    />
  );
}

function DiffTool() {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [opts, setOpts] = useState({ ignoreSpace: false, ignoreCase: false });
  const r = a || b ? attempt(() => diffLines(a, b, opts)) : { value: null, error: null };
  const stats = r.value ? diffStats(r.value) : null;
  return (
    <div className="space-y-4">
      <Two left={<Pane label="Before" id="util-in"><Textarea value={a} onChange={(e) => setA(e.target.value)} rows={8} aria-label="Text before" className={`${mono} w-full`} data-testid="diff-a" /></Pane>}
        right={<Pane label="After" id="util-in-b"><Textarea value={b} onChange={(e) => setB(e.target.value)} rows={8} aria-label="Text after" className={`${mono} w-full`} data-testid="diff-b" /></Pane>} />
      <Pane label="Changes" id="util-out" actions={<>
        <label className="flex min-h-11 items-center gap-1.5 text-[13px] text-muted sm:min-h-0"><input type="checkbox" checked={opts.ignoreSpace} onChange={(e) => setOpts({ ...opts, ignoreSpace: e.target.checked })} className={ring} />Ignore spaces</label>
        <label className="flex min-h-11 items-center gap-1.5 text-[13px] text-muted sm:min-h-0"><input type="checkbox" checked={opts.ignoreCase} onChange={(e) => setOpts({ ...opts, ignoreCase: e.target.checked })} className={ring} />Ignore case</label>
      </>}>
        <ErrorLine text={r.error} />
        {stats && <p className="text-[13px] text-muted" data-testid="diff-stats">{stats.added === 0 && stats.removed === 0 ? "No changes" : `${stats.added} added, ${stats.removed} removed`}</p>}
        {r.value && (stats!.added || stats!.removed) ? (
          <div className="max-h-[480px] overflow-auto rounded-lg border border-line" data-testid="diff-view">
            {r.value.map((l, i) => (
              <div key={i} className={`flex ${mono} ${l.kind === "add" ? "bg-ok/10" : l.kind === "del" ? "bg-bad/10" : ""}`}>
                <span className="w-10 shrink-0 select-none px-2 text-right text-subtle">{l.a ?? ""}</span><span className="w-10 shrink-0 select-none px-2 text-right text-subtle">{l.b ?? ""}</span>
                <span className="w-5 shrink-0 select-none text-center" aria-hidden>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                <span className="sr-only">{l.kind === "add" ? "Added: " : l.kind === "del" ? "Removed: " : ""}</span>
                <span className="min-w-0 whitespace-pre-wrap break-words pr-2">{l.text || " "}</span>
              </div>
            ))}
          </div>
        ) : null}
        {!a && !b && <p className="text-[13px] text-subtle">Paste two versions to see what changed.</p>}
      </Pane>
    </div>
  );
}

function RegexTool() {
  const [pattern, setPattern] = useState("\\b\\w+@\\w+\\.\\w+\\b");
  const [flags, setFlags] = useState("g");
  const [text, setText] = useState("Write to ana@site.com or bo@mail.org");
  const r = attempt(() => testRegex(pattern, flags, text));
  const marked = useMemo(() => {
    if (!r.value) return [text];
    const parts: ReactNode[] = []; let at = 0;
    r.value.matches.forEach((m, i) => { if (m.index > at) parts.push(text.slice(at, m.index)); parts.push(<mark key={i} className="rounded bg-brand/20 text-fg">{m.text || "\u200b"}</mark>); at = m.index + m.text.length; });
    parts.push(text.slice(at)); return parts;
  }, [r.value, text]);
  return (
    <Two
      left={<Pane label="Pattern and text" id="util-in">
        <div className="flex gap-2"><div className="min-w-0 flex-1"><Input value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Pattern" className={mono} spellCheck={false} data-testid="regex-pattern" /></div><div className="w-20 shrink-0"><Input value={flags} onChange={(e) => setFlags(e.target.value.trim())} aria-label="Flags" className={mono} data-testid="regex-flags" /></div></div>
        <ErrorLine text={r.error} />
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} aria-label="Text to test" className={`${mono} w-full`} data-testid="regex-text" />
      </Pane>}
      right={<Pane label={r.value ? `${r.value.matches.length}${r.value.capped ? "+" : ""} ${r.value.matches.length === 1 ? "match" : "matches"}` : "Matches"} id="util-out" actions={r.value && r.value.matches.length > 0 ? <CopyButton value={r.value.matches.map((m) => m.text).join("\n")} label="Copy matches" toastText="Copied" /> : undefined}>
        <div className={`${mono} whitespace-pre-wrap break-words rounded-lg bg-fill/40 p-3`} data-testid="regex-marked">{marked}</div>
        {r.value && r.value.matches.length > 0 && (
          <ol className="space-y-1.5" data-testid="regex-matches">{r.value.matches.slice(0, 50).map((m, i) => (
            <li key={i} className="rounded-lg border border-line px-2.5 py-1.5 text-[13px]"><span className="text-muted">At {m.index}: </span><span className={mono}>{m.text}</span>{m.groups.length > 0 && <span className="text-muted"> · groups {m.groups.map((g) => g ?? "none").join(", ")}</span>}</li>
          ))}</ol>
        )}
      </Pane>}
    />
  );
}

const TOOL_VIEW: Record<string, () => ReactNode> = { data: DataTool, base64: Base64Tool, hash: HashTool, uuid: UuidTool, qr: QrTool, colour: ColourTool, units: UnitsTool, time: TimeTool, diff: DiffTool, regex: RegexTool };

export function UtilitiesPage() {
  const { id } = useParams();
  const def = id ? UTILITIES.find((u) => u.id === id) : null;
  if (id && !def) return <NotFound embedded />;
  if (!def) {
    return (
      <ToolsFrame entryKey="utilities" title="Utilities" description="Small everyday helpers for data, text, colours and time. Everything stays on your device." usage={false} testId="utilities-page">
        <ul className="grid gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-3" data-testid="utilities-grid">
          {UTILITIES.map((u) => (
            <li key={u.id}><Link to={`/app/tools/utilities/${u.id}`} className={`flex min-h-16 flex-col justify-center rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:border-brand/50 hover:bg-hover ${ring}`} data-testid={`utility-${u.id}`}>
              <span className="text-[14.5px] font-semibold">{u.name}</span><span className="text-[13px] text-muted">{u.line}</span>
            </Link></li>
          ))}
        </ul>
      </ToolsFrame>
    );
  }
  const View = TOOL_VIEW[def.id];
  return (
    <ToolsFrame entryKey="utilities" title={def.name} description={`${def.line}. Nothing you type leaves your device.`} usage={false} wide testId={`utility-page-${def.id}`}>
      <View />
    </ToolsFrame>
  );
}
