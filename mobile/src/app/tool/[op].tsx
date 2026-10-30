import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform, Pressable, ScrollView, Share, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Banner, Button, EmptyState, Icon, Loading } from "@/components/ui";
import { FileChip, MailAttachmentSheet, OptionField, RunSteps, SourceButton, ToolTile, openOnWeb } from "@/components/tool-ui";
import { useSession } from "@/lib/session";
import { useTools } from "@/lib/queries";
import { HttpTransport } from "@/api/transport";
import { success, tick, warning } from "@/lib/haptics";
import {
  defaultsFor, filesProblem, maxFilesFor, mb, optionProblem, optionShown, POLL_GIVE_UP_MS, pollDelay, resultExt, resultLine, runsOnPhone, typeForName,
  type PickedFile, type ToolDef, type ToolJob,
} from "@/lib/tools";
import { asPicked, downloadResult, openFile, pickFiles, readResultText, saveToPhone, shareFile, uploadJob } from "@/lib/tools-files";
import { ADVANCED, buildEntries, middleTruncate, noRunsLine, offlineDelay, runsLeft, runsLeftLabel, savedLine, sizeLabel, waitLine, type Entry } from "@/lib/tool-directory";
import { attachToNewEmail, carryFile, clearRun, loadRun, rememberRecent, saveRun, takeCarried, type SavedRun } from "@/lib/tool-run";
import { groupMatches, parseMatches, phrasesFor, PII_KINDS, type PiiMatch } from "@/lib/auto-redact";
import { colors, radius, space, TOUCH } from "@/theme";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; pct: number }
  | { kind: "working"; job: ToolJob; since: number; offline?: boolean; slow?: boolean }
  | { kind: "review"; matches: PiiMatch[] }
  | { kind: "done"; job: ToolJob }
  | { kind: "failed"; title: string; message: string; offline?: boolean; limit?: boolean };

type Downloaded = Awaited<ReturnType<typeof downloadResult>>;
const isOffline = (e: unknown) => (e as { status?: number })?.status === 0;
/** The clock, read only in events and effects. */
const nowMs = () => Date.now();
const ALL_KINDS = JSON.stringify(PII_KINDS.map((k) => k.kind));

/**
 * One tool, one screen (Tools P2): pick files (Files, Photos on Android, or an email attachment), the options that
 * matter with the rest folded, one Run button at the bottom, then Upload, Work, Done with Cancel, then the result
 * (size saved, Open, Save or Share, Attach to a new email, Use in another tool, Start over). The run is kept on the
 * phone, so it comes back after the app was in the background or closed, and a dropped connection is retried on
 * its own. The same server routes and words as the web Tools page.
 */
export default function ToolScreen() {
  const params = useLocalSearchParams<{ op: string; attachment?: string; name?: string; resume?: string; carried?: string }>();
  const op = String(params.op ?? "");
  const q = useTools();
  const { api, mode, transport } = useSession();
  const insets = useSafeAreaInsets();
  const def: ToolDef | undefined = q.data?.tools.find((t) => t.op === op);
  const entry: Entry | undefined = useMemo(() => (q.data ? buildEntries(q.data).find((e) => e.key === op) : undefined), [q.data, op]);
  const auth = transport instanceof HttpTransport ? transport.fileAuth() : null;

  const [files, setFiles] = useState<PickedFile[]>(() => { const c = params.carried ? takeCarried() : null; return c ? [c] : []; });
  const [fromMail, setFromMail] = useState<{ id: string; name: string; size?: number } | null>(params.attachment ? { id: String(params.attachment), name: String(params.name ?? "Attachment") } : null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [more, setMore] = useState(false);
  const [mailOpen, setMailOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [before, setBefore] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cold, setCold] = useState(false);
  const [now, setNow] = useState(0);
  const [file, setFile] = useState<Downloaded | null>(null);
  const [fetching, setFetching] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const cancelled = useRef(false);
  /** Auto redact runs twice: find, then black out. */
  const [step, setStep] = useState<"find" | "burn">("find");
  const options: Record<string, string> = { ...defaultsFor(def), ...edited };
  const busy = phase.kind === "uploading" || phase.kind === "working";
  const flow = def?.flow === "autoredact";

  // A sleeping document engine starts waking when the screen opens; a slow answer means the first run waits a bit.
  useEffect(() => {
    if (mode !== "live") return;
    const t0 = Date.now();
    api.toolsWarm().then((r) => setCold(!r.ok || r.ms > 2500 || Date.now() - t0 > 3000)).catch(() => {});
  }, [api, mode]);

  // Pick a run back up: after the app was closed or in the background, or when opened from the Tools screen.
  useEffect(() => {
    let gone = false;
    void loadRun().then((r: SavedRun | null) => {
      if (gone || !r || r.op !== op) return;
      if (!params.resume && (params.attachment || params.carried)) return;
      setBefore(r.before ?? null);
      if (r.name && !params.attachment) setFiles((cur) => (cur.length ? cur : [{ uri: "", name: r.name, size: r.before ?? 0, type: typeForName(r.name) }]));
      setPhase(r.done ? { kind: "done", job: r.done } : { kind: "working", job: { token: r.token, op: r.op, status: "running", name: r.name }, since: r.at });
    });
    return () => { gone = true; };
  }, [op, params.resume, params.attachment, params.carried]);

  // A clock for the elapsed seconds while a run works.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(nowMs()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const finished = async (j: ToolJob) => {
    void q.refetch();
    if (flow && step === "find") {
      // Auto redact, step one: read what was found and let the person choose what to black out.
      try {
        const text = auth ? await readResultText(auth, j) : SAMPLE_FOUND;
        const found = parseMatches(text);
        setTicked(new Set(groupMatches(found).flatMap((g) => g.items.map((m) => m.key))));
        void clearRun();
        setPhase({ kind: "review", matches: found });
      } catch (e) { setPhase({ kind: "failed", title: "Couldn't read what was found", message: (e as Error).message || "Try again." }); }
      return;
    }
    success();
    const r = await loadRun();
    if (r && r.token === j.token) void saveRun({ ...r, done: j });
    setPhase({ kind: "done", job: j });
  };

  // Check the job until it is done or failed (checking costs the server no database read). A dropped connection
  // keeps the job: the screen says so and checks again with a growing wait, and at once when the app comes back.
  const token = phase.kind === "working" ? phase.job.token : null;
  useEffect(() => {
    if (!token) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    let attempt = 0;
    const started = Date.now();
    const next = (ms: number) => { if (!stop) { clearTimeout(timer); timer = setTimeout(check, ms); } };
    const check = async () => {
      try {
        const j = await api.toolJob(token);
        if (stop) return;
        misses = 0;
        if (j.status === "done") { void finished(j); return; }
        if (j.status === "failed") {
          warning(); void clearRun();
          setPhase({ kind: "failed", title: "That didn't work", message: `${j.error || "This file could not be processed. Check that it opens on your phone, then try again."} This run was not counted.` });
          void q.refetch();
          return;
        }
        if (j.status === "expired" || j.status === "cancelled") {
          void clearRun();
          setPhase({ kind: "failed", title: "This result has expired", message: "Results are kept for an hour. Run the tool again." });
          return;
        }
        setPhase((p) => (p.kind === "working" ? { ...p, offline: false, job: { ...p.job, progress: j.progress }, slow: Date.now() - started > 8000 } : p));
      } catch (e) {
        if (stop) return;
        if (isOffline(e)) { setPhase((p) => (p.kind === "working" ? { ...p, offline: true } : p)); next(offlineDelay(misses++)); return; }
        const status = (e as { status?: number }).status;
        if (status === 404) { void clearRun(); setPhase({ kind: "failed", title: "This result has expired", message: "Results are kept for an hour. Run the tool again." }); return; }
        if (status !== 503 && status !== 502) { void clearRun(); setPhase({ kind: "failed", title: "That didn't work", message: (e as Error).message || "Couldn't check on the file. Try again." }); return; }
      }
      if (Date.now() - started > POLL_GIVE_UP_MS) { setPhase({ kind: "failed", title: "This is taking too long", message: "Try again with a smaller file." }); return; }
      next(pollDelay(attempt++));
    };
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") { misses = 0; next(0); } });
    next(800);
    return () => { stop = true; clearTimeout(timer); sub.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, api]);

  // An upload that failed because the phone was offline tries again on its own: when the app is back in front,
  // and every so often meanwhile (2, 4, 8, then every 15 seconds). Cancel, Stop trying and leaving end it.
  const retry = useRef<{ timer?: ReturnType<typeof setTimeout>; sub?: { remove: () => void }; n: number }>({ n: 0 });
  useEffect(() => { const r = retry.current; return () => { clearTimeout(r.timer); r.sub?.remove(); }; }, []);


  if (q.isPending) return <Loading rows={5} />;
  if (q.error) {
    const off = (q.error as { status?: number }).status === 404;
    return <EmptyState icon="wrench" title={off ? "Tools are off" : "Couldn't load Tools"} body={off ? "Tools are switched off for this workspace. An admin can turn them on in Settings, General on multies.si." : q.error.message} />;
  }
  if (!def || !runsOnPhone(def)) {
    return (
      <>
      <Stack.Screen options={{ title: entry?.name ?? "Tools" }} />
      <EmptyState icon="wrench" title={def ? `${entry?.name ?? def.label} works on the web` : "This tool isn't available"}
        body={def ? "It needs a bigger screen. Open it on multies.si." : "It may be switched off for this workspace."}
        action={def?.path ? <Button label="Open on the web" icon="external-link" onPress={() => openOnWeb(def.path!)} /> : undefined} />
      </>
    );
  }

  const name = entry?.name ?? def.label;
  const limits = q.data.limits;
  const left = runsLeft(q.data.usage, limits);
  const max = maxFilesFor(def, limits);
  const shown = def.options.filter((o) => o.kind !== "json" && optionShown(o, options));
  const foldNames = shown.length >= 4 ? ADVANCED[def.op] ?? [] : [];
  const essential = shown.filter((o) => !foldNames.includes(o.name) || o.required);
  const advanced = shown.filter((o) => foldNames.includes(o.name) && !o.required);
  const optionErrors = Object.fromEntries(shown.map((o) => [o.name, optionProblem(o, options[o.name] ?? "")]));
  const firstOptionError = Object.values(optionErrors).find(Boolean) ?? null;
  const fileError = fromMail ? null : filesProblem(def, files, limits);
  const noRuns = left.left === 0;
  const canRun = !busy && !noRuns && !fileError && !firstOptionError;
  const haveFiles = !!fromMail || files.length > 0;
  const takesImages = /image\/|\.jpe?g|\.png|\.webp/.test(def.accept);
  const typeOption = def.extBy ? { name: def.extBy.option, value: options[def.extBy.option] ?? "" } : undefined;
  const elapsed = phase.kind === "working" ? Math.max(0, Math.round((now - phase.since) / 1000)) : 0;
  const waking = cold && ((phase.kind === "uploading" && phase.pct >= 100) || (phase.kind === "working" && elapsed >= 4 && !phase.job.progress));

  const add = async (only?: "images") => {
    if (busy) return;
    setNotice(null);
    if (Platform.OS === "web" && mode === "sample") {
      const n = files.length + 1;
      const name = def.op === "convert" ? "Quarterly report.docx" : /image|jpe?g|png/.test(def.accept) && !/pdf/.test(def.accept) ? `Photo ${n}.jpg` : /xlsx|csv/.test(def.accept) ? `Sales ${n}.xlsx` : `Quarterly report ${n}.pdf`;
      setFromMail(null);
      setFiles((cur) => [...cur, { uri: "sample://file", name, size: 2_480_000 + n * 1000, type: typeForName(name) }].slice(0, max));
      return;
    }
    try {
      const picked = await pickFiles(def, max > 1, only);
      if (!picked.length) return;
      setFromMail(null);
      setPhase({ kind: "idle" }); setFile(null);
      setFiles((cur) => (max === 1 ? picked.slice(0, 1) : [...cur, ...picked].slice(0, max)));
    } catch {
      Alert.alert("Couldn't open your files", "Try again, or check that Multies may use Files in your phone's Settings.");
    }
  };

  const sendOptions = (extra?: Record<string, string>) => {
    const o = Object.fromEntries(Object.entries(options).filter(([k, v]) => v.trim() !== "" && shown.some((x) => x.name === k)));
    return { ...o, ...extra };
  };

  const stopRetry = () => { const r = retry.current; clearTimeout(r.timer); r.sub?.remove(); r.sub = undefined; };
  const start = async (runOp: string, opts: Record<string, string>, again: () => void) => {
    cancelled.current = false;
    stopRetry();
    setNotice(null); setFile(null);
    const was = def.op === "compress" && !fromMail ? files[0]?.size || null : null;
    setBefore(was);
    try {
      let job: ToolJob;
      if (fromMail) { setPhase({ kind: "uploading", pct: 100 }); job = await api.toolFromAttachments(runOp, [fromMail.id], opts); }
      else if (!auth) { setPhase({ kind: "uploading", pct: 100 }); job = await api.toolFromAttachments(runOp, [], { ...opts, name: files[0]?.name ?? "" }); }
      else {
        setPhase({ kind: "uploading", pct: 0 });
        job = await uploadJob(auth, runOp, files, opts, (f) => { if (!cancelled.current) setPhase({ kind: "uploading", pct: Math.round(f * 100) }); }, runOp === def.op ? typeOption : undefined);
      }
      if (cancelled.current) { api.cancelToolJob(job.token).catch(() => {}); return; }
      retry.current.n = 0;
      if (!flow) void saveRun({ token: job.token, op: def.op, name: fromMail?.name ?? files[0]?.name ?? job.name, before: was, at: nowMs() });
      setPhase({ kind: "working", job, since: nowMs() });
    } catch (e) {
      if (cancelled.current) return;
      const status = (e as { status?: number }).status;
      const message = (e as Error)?.message || "That didn't work. Try again.";
      warning();
      if (isOffline(e)) {
        setPhase({ kind: "failed", title: "You're offline", message: "Your files are kept. This tries again by itself when you're back online.", offline: true });
        const r = retry.current;
        const go = () => { stopRetry(); again(); };
        r.timer = setTimeout(go, offlineDelay(r.n++));
        r.sub = AppState.addEventListener("change", (st) => { if (st === "active") go(); });
        return;
      }
      retry.current.n = 0;
      const limit = status === 429 || status === 413;
      setPhase({
        kind: "failed",
        title: limit ? "Over your plan's limit" : status === 503 ? "Tools are still starting" : "That didn't work",
        message: status === 429 ? `${message} Your files were not used.` : status === 503 ? "The document engine is taking longer than usual to start. Try again in a few seconds." : message,
        limit,
      });
      void q.refetch();
    }
  };

  const run = async () => {
    setTouched(true);
    if (!canRun) { warning(); return; }
    tick();
    void rememberRecent(def.op);
    if (flow) { setStep("find"); await start("pii-find", { kinds: ALL_KINDS }, () => void run()); return; }
    await start(def.op, sendOptions(), () => void run());
  };

  const burn = async () => {
    if (phase.kind !== "review") return;
    const phrases = phrasesFor(phase.matches, ticked);
    if (!phrases) return;
    tick();
    setStep("burn");
    await start("redact", { phrases }, () => void burn());
  };

  // Cancel stops the job on the server too, so its place is free for the next run and it is not counted.
  const cancel = () => {
    tick();
    cancelled.current = true;
    stopRetry();
    if (phase.kind === "working") api.cancelToolJob(phase.job.token).catch(() => {});
    void clearRun();
    setPhase({ kind: "idle" });
    setNotice("Stopped. This run was not counted.");
  };
  const startOver = () => {
    tick();
    void clearRun();
    setFiles([]); setFromMail(null); setEdited({}); setTouched(false); setPhase({ kind: "idle" }); setNotice(null); setBefore(null); setFile(null);
  };

  const getFile = async (job: ToolJob): Promise<Downloaded | null> => {
    if (!auth) { Alert.alert("Sample result", "Files in the sample workspace are examples, so there is nothing to open."); return null; }
    if (file) return file;
    setFetching(true);
    try { const f = await downloadResult(auth, job); setFile(f); return f; }
    catch (e) { Alert.alert("Couldn't get the file", (e as Error)?.message || "Try again."); return null; }
    finally { setFetching(false); }
  };
  const doOpen = async (job: ToolJob) => { const f = await getFile(job); if (f) await openFile(f).catch(() => {}); };
  const doShare = async (job: ToolJob) => { const f = await getFile(job); if (f) await shareFile(f).catch(() => {}); };
  const doSave = async (job: ToolJob) => {
    const f = await getFile(job);
    if (!f) return;
    if (Platform.OS === "ios") { await Share.share({ url: f.uri }).catch(() => {}); return; }
    try { if (await saveToPhone(f, job.name, def.contentType)) { success(); setNotice(`Saved ${job.name}.`); } }
    catch { Alert.alert("Couldn't save", "Choose another folder and try again."); }
  };
  const doAttach = (job: ToolJob) => {
    if (!attachToNewEmail([job])) { Alert.alert("Couldn't attach", "This result has expired. Run the tool again."); return; }
    tick();
    router.push({ pathname: "/compose", params: { tools: "1" } });
  };
  const doChain = async (job: ToolJob) => {
    const type = typeForName(job.name, def.contentType);
    if (!auth) { carryFile({ uri: "sample://file", name: job.name, size: job.bytes ?? 0, type }); }
    else { const f = await getFile(job); if (!f) return; carryFile(asPicked(f, job.name, type)); }
    void clearRun();
    tick();
    if (router.canGoBack()) router.back(); else router.replace("/tools");
  };

  const progressLine = phase.kind === "uploading"
    ? (phase.pct >= 100 ? (fromMail ? "Getting the attachment from your email" : "Sending to the document engine") : `Uploading ${phase.pct}%`)
    : phase.kind === "working" ? (phase.offline ? "You're offline. Waiting to reconnect" : flow && step === "find" ? "Looking for sensitive info" : waitLine(def, phase.job, !!phase.slow)) : "";
  const pct = phase.kind === "uploading" ? (phase.pct >= 100 ? null : phase.pct) : phase.kind === "working" && phase.job.progress && phase.job.progress.total > 0 ? Math.round((phase.job.progress.done / phase.job.progress.total) * 100) : null;
  const primaryLabel = phase.kind === "failed" ? "Try again" : flow ? "Find sensitive info" : def.label;
  const showBottom = phase.kind === "idle" || (phase.kind === "failed" && !phase.offline) || phase.kind === "review";

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: "", headerRight: () => <Button variant="ghost" label="Done" onPress={() => (router.canGoBack() ? router.back() : router.replace("/tools"))} testID="tool-close" style={{ minHeight: 36, paddingHorizontal: 8 }} /> }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 3 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" testID={`tool-screen-${def.op}`}>
        {/* R70: the same frame as the web Tools pages: All tools, icon, name, one line, runs left, and the no runs note up front. */}
        <Pressable onPress={() => { tick(); if (router.canGoBack()) router.back(); else router.replace("/tools"); }} accessibilityRole="button" accessibilityLabel="All tools" testID="tool-all-tools"
          style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: TOUCH, alignSelf: "flex-start", marginTop: -space.sm, marginBottom: -space.sm }}>
          <Icon name="chevron-left" size={18} color={colors.brand} />
          <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>All tools</Text>
        </Pressable>
        <View style={{ gap: space.sm }} testID="tool-frame-header">
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            {entry ? <ToolTile entry={entry} size={48} /> : null}
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: colors.fg, fontSize: 20, fontWeight: "700" }} accessibilityRole="header" numberOfLines={2}>{name}</Text>
              <Text style={{ color: colors.muted, fontSize: 14.5, lineHeight: 20 }}>{def.blurb}</Text>
            </View>
          </View>
          <Text style={{ color: noRuns ? colors.bad : colors.subtle, fontSize: 13.5, fontWeight: "500" }} testID="tool-usage">{runsLeftLabel(left)}</Text>
          {noRuns && phase.kind !== "done" ? (
            <View style={{ padding: space.md, borderRadius: radius.md, backgroundColor: colors.badSoft }} accessibilityRole="alert">
              <Text style={{ color: colors.fg, fontSize: 14, lineHeight: 20 }} testID="tool-no-runs">{noRunsLine(left)}</Text>
            </View>
          ) : null}
        </View>

        {phase.kind === "done" ? (
          <ResultCard job={phase.job} before={before} level={def.op === "compress" ? options.level : undefined} fetching={fetching} chainable={resultExt(def, options) !== "zip" && !flow}
            onOpen={() => doOpen(phase.job)} onSave={() => doSave(phase.job)} onShare={() => doShare(phase.job)} onAttach={() => doAttach(phase.job)}
            onChain={() => doChain(phase.job)} onStartOver={startOver} />
        ) : phase.kind === "review" ? (
          <ReviewList matches={phase.matches} ticked={ticked} setTicked={setTicked} />
        ) : (
          <>
            {/* Files */}
            {!busy ? (
              <View style={{ gap: space.sm }}>
                {fromMail ? (
                  <>
                    <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>From your email</Text>
                    <FileChip name={fromMail.name} size={fromMail.size} onRemove={params.attachment ? undefined : () => setFromMail(null)} testID="tool-mail-file" />
                  </>
                ) : files.length ? (
                  <>
                    <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>{files.length === 1 ? "Your file" : `${files.length} files${def.ordered ? ", in this order" : ""}`}</Text>
                    {files.map((f, i) => (
                      <FileChip key={`${f.uri}-${i}`} name={f.name} size={f.size} uri={f.uri} type={f.type} index={def.ordered && files.length > 1 ? i : undefined} testID={`tool-file-${i}`}
                        onRemove={() => setFiles((cur) => cur.filter((_, k) => k !== i))}
                        onUp={def.ordered && i > 0 ? () => setFiles((cur) => { const n = [...cur]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; }) : undefined}
                        onDown={def.ordered && i < files.length - 1 ? () => setFiles((cur) => { const n = [...cur]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; }) : undefined} />
                    ))}
                  </>
                ) : null}
                {!fromMail && (files.length < max) ? (
                  <View style={{ gap: space.sm }}>
                    {!files.length ? <Text style={{ color: colors.muted, fontSize: 14 }}>{`Add ${def.acceptLabel}`}</Text> : null}
                    <View style={{ flexDirection: "row", gap: space.sm }}>
                      <SourceButton icon="file-text" label={files.length ? "Add more" : "Files"} onPress={() => add()} testID="tool-add-files" />
                      {takesImages && Platform.OS !== "ios" ? <SourceButton icon="smartphone" label="Photos" onPress={() => add("images")} testID="tool-add-photos" /> : null}
                      {def.minFiles <= 1 && !files.length ? <SourceButton icon="mail" label="From email" onPress={() => setMailOpen(true)} testID="tool-add-mail" /> : null}
                    </View>
                  </View>
                ) : null}
                {!haveFiles ? <Text style={{ color: colors.subtle, fontSize: 13, lineHeight: 18 }} testID="tool-limits">{`Up to ${mb(Math.min(limits.maxBytes, def.maxBytes ?? Infinity))}${def.maxPages ? ` and ${def.maxPages} pages` : ""}. Files are deleted from our servers within an hour.`}</Text> : null}
                {touched && fileError && !busy ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityRole="alert">{fileError}</Text> : null}
              </View>
            ) : null}

            {/* Options: what matters first, the rest folded */}
            {!busy && !flow && haveFiles && essential.length ? (
              <View style={{ gap: space.md }}>
                {essential.map((o) => <OptionField key={o.name} o={o} value={options[o.name] ?? ""} error={touched ? optionErrors[o.name] : null} onChange={(v) => setEdited((c) => ({ ...c, [o.name]: v }))} />)}
              </View>
            ) : null}
            {!busy && !flow && haveFiles && advanced.length ? (
              <View style={{ gap: space.md }}>
                <Pressable onPress={() => { tick(); setMore((m) => !m); }} accessibilityRole="button" accessibilityState={{ expanded: more }} testID="tool-more"
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: TOUCH }}>
                  <Icon name={more ? "chevron-up" : "chevron-down"} size={16} color={colors.brand} />
                  <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>More options</Text>
                  <Text style={{ color: colors.subtle, fontSize: 13, flex: 1 }} numberOfLines={1}>{advanced.map((o) => o.label.toLowerCase()).join(", ")}</Text>
                </Pressable>
                {more ? advanced.map((o) => <OptionField key={o.name} o={o} value={options[o.name] ?? ""} error={touched ? optionErrors[o.name] : null} onChange={(v) => setEdited((c) => ({ ...c, [o.name]: v }))} />) : null}
              </View>
            ) : null}
            {!busy && flow && haveFiles ? <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>Looks for tax file numbers, ABNs, ACNs, bank details, card and Medicare numbers, phones and emails. You choose what to black out next.</Text> : null}
            {!busy && def.note && haveFiles ? <Text style={{ color: colors.subtle, fontSize: 13, lineHeight: 18 }}>{def.note}</Text> : null}

            {busy ? (
              <>
                <FileChip name={fromMail?.name ?? files[0]?.name ?? (phase.kind === "working" ? phase.job.name : "")} size={fromMail ? undefined : files[0]?.size} />
                <RunSteps at={phase.kind === "uploading" ? "upload" : "work"} pct={pct} line={progressLine} elapsed={elapsed}
                  note={waking && !(phase.kind === "working" && phase.offline) ? "Starting up. The first run after a quiet while can take up to a minute. You can leave this screen; the run keeps going." : null}
                  onCancel={cancel} />
              </>
            ) : null}

            {phase.kind === "failed" ? (
              <View style={{ gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: phase.offline ? colors.warnSoft : colors.badSoft }} testID="tool-failed" accessibilityRole="alert">
                <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>{phase.title}</Text>
                <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>{phase.message}</Text>
                {phase.offline ? (
                  <Pressable onPress={() => { tick(); stopRetry(); retry.current.n = 0; setPhase({ kind: "idle" }); }} accessibilityRole="button" testID="tool-stop-retry" style={{ minHeight: TOUCH, justifyContent: "center", alignSelf: "flex-start" }}>
                    <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>Stop trying</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {notice ? <Text style={{ color: colors.muted, fontSize: 14 }} testID="tool-notice">{notice}</Text> : null}
          </>
        )}
      </ScrollView>

      {showBottom ? (
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: Math.max(insets.bottom, space.md), gap: space.sm, borderTopWidth: 0.5, borderTopColor: colors.line, backgroundColor: colors.bg }}>
          {phase.kind === "review" ? (
            <Button label={ticked.size ? `Black out ${ticked.size} ${ticked.size === 1 ? "item" : "items"}` : "Tick what to black out"} icon="shield" disabled={!ticked.size || noRuns} onPress={burn} testID="tool-burn" />
          ) : (
            <Button label={primaryLabel} onPress={run} disabled={busy || noRuns} testID="tool-run" accessibilityHint={fileError ?? firstOptionError ?? undefined} />
          )}
        </View>
      ) : null}

      <MailAttachmentSheet visible={mailOpen} tool={def} onClose={() => setMailOpen(false)}
        onPick={(a) => { setMailOpen(false); setFiles([]); setFromMail({ id: a.id, name: a.filename, size: a.sizeBytes }); setPhase({ kind: "idle" }); }} />
    </View>
  );
}

/** The result: what was made, what it saved, and every next step. */
function ResultCard({ job, before, level, fetching, chainable, onOpen, onSave, onShare, onAttach, onChain, onStartOver }: {
  job: ToolJob; before: number | null; level?: string; fetching: boolean; chainable: boolean;
  onOpen: () => void; onSave: () => void; onShare: () => void; onAttach: () => void; onChain: () => void; onStartOver: () => void;
}) {
  const saved = before && job.bytes ? savedLine(before, job.bytes, level) : null;
  const facts = resultLine({ ...job, bytes: saved ? undefined : job.bytes });
  return (
    <View style={{ gap: space.md }} testID="tool-done">
      <View style={{ gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: "#34C759", alignItems: "center", justifyContent: "center" }}><Icon name="check" size={24} color="#FFFFFF" /></View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "600" }} numberOfLines={1} accessibilityLabel={job.name}>{middleTruncate(job.name, 32)}</Text>
            {saved ? <Text style={{ color: colors.ok, fontSize: 14, fontWeight: "600" }} testID="tool-saved">{saved}</Text> : null}
            {facts ? <Text style={{ color: colors.muted, fontSize: 13.5 }} testID="tool-facts">{facts}</Text> : null}
          </View>
        </View>
        {job.notCounted ? <Text style={{ color: colors.muted, fontSize: 13.5 }}>Nothing to change was found, so this run was not counted.</Text> : null}
        <Button label={fetching ? "Getting the file" : "Open"} icon="eye" loading={fetching} onPress={onOpen} testID="tool-open" />
        <View style={{ flexDirection: "row", gap: space.sm }}>
          {Platform.OS === "ios" ? (
            <Button variant="secondary" label="Save or share" icon="download" onPress={onShare} testID="tool-share" style={{ flex: 1 }} />
          ) : (
            <>
              <Button variant="secondary" label="Save" icon="download" onPress={onSave} testID="tool-save" style={{ flex: 1 }} />
              <Button variant="secondary" label="Share" icon="send" onPress={onShare} testID="tool-share" style={{ flex: 1 }} />
            </>
          )}
        </View>
        <Button variant="secondary" label="Attach to a new email" icon="mail" onPress={onAttach} testID="tool-attach" />
        <Text style={{ color: colors.subtle, fontSize: 12.5 }}>{`${job.bytes ? `${sizeLabel(job.bytes)}. ` : ""}Kept for an hour, then deleted.`}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" }}>
        {chainable ? (
          <Pressable onPress={onChain} accessibilityRole="button" testID="tool-chain" style={{ minHeight: TOUCH, justifyContent: "center", flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>Use in another tool</Text>
            <Icon name="arrow-right" size={15} color={colors.brand} />
          </Pressable>
        ) : <View />}
        <Pressable onPress={onStartOver} accessibilityRole="button" testID="tool-start-over" style={{ minHeight: TOUCH, justifyContent: "center" }}>
          <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>Start over</Text>
        </Pressable>
      </View>
    </View>
  );
}

const mask = (t: string) => (t.length <= 4 ? t : `${t.slice(0, Math.max(2, t.length - 6))}${"•".repeat(Math.min(6, t.length - 2))}`);

/** Auto redact, step two: everything found, grouped and ticked; untick what should stay. */
function ReviewList({ matches, ticked, setTicked }: { matches: PiiMatch[]; ticked: Set<string>; setTicked: (f: (s: Set<string>) => Set<string>) => void }) {
  const [reveal, setReveal] = useState(false);
  const groups = groupMatches(matches);
  if (!groups.length) {
    return (
      <View style={{ gap: space.sm, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface }} testID="tool-review-empty">
        <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "600" }}>Nothing sensitive found</Text>
        <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>No tax, bank, card or Medicare numbers, phones or emails were found. This run was not counted.</Text>
      </View>
    );
  }
  const toggle = (key: string) => setTicked((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  return (
    <View style={{ gap: space.md }} testID="tool-review">
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ flex: 1, color: colors.fg, fontSize: 16, fontWeight: "600" }}>{`Found ${matches.length} ${matches.length === 1 ? "item" : "items"}`}</Text>
        <Pressable onPress={() => setReveal((r) => !r)} accessibilityRole="button" style={{ minHeight: TOUCH, justifyContent: "center" }} testID="tool-reveal">
          <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>{reveal ? "Hide" : "Show all"}</Text>
        </Pressable>
      </View>
      {groups.map((g) => (
        <View key={g.kind} style={{ borderRadius: 12, overflow: "hidden", backgroundColor: colors.surface }}>
          <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 4 }}>{g.label}</Text>
          {g.items.map((m) => {
            const on = ticked.has(m.key);
            return (
              <Pressable key={m.key} onPress={() => { tick(); toggle(m.key); }} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`${g.label}: ${m.text}, page ${m.page}`}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 4, paddingHorizontal: space.lg, backgroundColor: pressed ? colors.hover : "transparent" })}>
                <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: on ? 0 : 1.5, borderColor: colors.lineStrong, backgroundColor: on ? colors.brandFill : "transparent", alignItems: "center", justifyContent: "center" }}>
                  {on ? <Icon name="check" size={14} color="#FFFFFF" /> : null}
                </View>
                <Text style={{ flex: 1, color: colors.fg, fontSize: 15, fontVariant: ["tabular-nums"] }} numberOfLines={1}>{reveal ? m.text : mask(m.text)}</Text>
                <Text style={{ color: colors.subtle, fontSize: 13 }}>{`Page ${m.page}`}</Text>
              </Pressable>
            );
          })}
        </View>
      ))}
      <Banner tone="warn" icon="alert-circle" text="Blacking out cannot be undone. The ticked items are covered on every page and the result is checked so none can be found." />
    </View>
  );
}

/** What the sample workspace pretends to find. */
const SAMPLE_FOUND = JSON.stringify({ matches: [
  { kind: "tfn", text: "123 456 782", page: 1 }, { kind: "abn", text: "51 824 753 556", page: 1 },
  { kind: "bsb_account", text: "062-000 1234 5678", page: 2 }, { kind: "email", text: "li.chen@greenroofcafe.com.au", page: 2 },
] });
