import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Badge, Banner, Button, EmptyState, Field, Icon, IconButton, Loading, Segmented } from "@/components/ui";
import { useSession } from "@/lib/session";
import { useTools } from "@/lib/queries";
import { HttpTransport } from "@/api/transport";
import { success, tick, warning } from "@/lib/haptics";
import { bytes } from "@/lib/format";
import {
  defaultsFor, filesProblem, maxFilesFor, optionProblem, pollDelay, POLL_GIVE_UP_MS, resultLine, toolIcon, typeForName, usageLine,
  type PickedFile, type ToolDef, type ToolJob, type ToolOption,
} from "@/lib/tools";
import { downloadResult, openFile, pickFiles, saveToPhone, shareFile, uploadJob } from "@/lib/tools-files";
import { colors, font, radius, space } from "@/theme";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; pct: number }
  | { kind: "working"; job: ToolJob }
  | { kind: "done"; job: ToolJob }
  | { kind: "failed"; message: string };

type Saved = Awaited<ReturnType<typeof downloadResult>>;

/**
 * One tool's sheet: choose files (or arrive with a mail attachment), set the options, run it, then open,
 * share or save the result. Same rules and words as the web Tools page.
 */
export default function ToolSheet() {
  const { op, attachment, name } = useLocalSearchParams<{ op: string; attachment?: string; name?: string }>();
  const q = useTools();
  const { api, mode, transport } = useSession();
  const def = q.data?.tools.find((t) => t.op === op);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [saved, setSaved] = useState<Saved | null>(null);
  const [fetching, setFetching] = useState(false);
  const options: Record<string, string> = { ...defaultsFor(def), ...edited };

  const fromMail = attachment ? { id: String(attachment), name: String(name ?? "Attachment") } : null;
  const auth = transport instanceof HttpTransport ? transport.fileAuth() : null;
  const busy = phase.kind === "uploading" || phase.kind === "working";

  // Check the job until it is done or failed. Checking costs the server no database read.
  const token = phase.kind === "working" ? phase.job.token : null;
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  useEffect(() => {
    if (!token) return;
    let gone = false;
    const started = Date.now();
    let attempt = 0;
    const tickJob = async () => {
      if (gone || stop.current) return;
      try {
        const job = await api.toolJob(token);
        if (gone) return;
        if (job.status === "done") { success(); setPhase({ kind: "done", job }); q.refetch(); return; }
        if (job.status === "failed" || job.status === "expired") {
          warning();
          setPhase({ kind: "failed", message: job.status === "expired" ? "This file has expired. Run the tool again." : job.error || "The file could not be processed." });
          return;
        }
        setPhase({ kind: "working", job });
      } catch { /* a dropped check; try again */ }
      if (Date.now() - started > POLL_GIVE_UP_MS) { setPhase({ kind: "failed", message: "This is taking too long. Try again with a smaller file." }); return; }
      setTimeout(tickJob, pollDelay(attempt++));
    };
    const first = setTimeout(tickJob, 800);
    return () => { gone = true; clearTimeout(first); };
  }, [token, api, q]);

  if (q.isPending) return <Loading rows={5} />;
  if (q.error) {
    const off = (q.error as { status?: number }).status === 404;
    return <EmptyState icon="wrench" title={off ? "Tools are off" : "Couldn't load Tools"} body={off ? "Tools are switched off for this workspace. An admin can turn them on in Settings, General on multies.si." : q.error.message} />;
  }
  if (!def) return <EmptyState icon="wrench" title="This tool isn't available" body="Update the app or open Tools on multies.si." />;

  const limits = q.data.limits;
  const usage = usageLine(q.data);
  const max = maxFilesFor(def, limits);
  const optionErrors = Object.fromEntries(def.options.map((o) => [o.name, optionProblem(o, options[o.name] ?? "")]));
  const firstOptionError = Object.values(optionErrors).find(Boolean) ?? null;
  const fileError = fromMail ? null : filesProblem(def, files, limits);
  const canRun = !busy && !usage.blocked && !fileError && !firstOptionError;

  const add = async () => {
    if (busy) return;
    tick();
    if (Platform.OS === "web" && mode === "sample") {
      setFiles((cur) => [...cur, { uri: "sample://file", name: def.ext === "pdf" && def.op === "convert" ? "Quarterly report.docx" : def.op === "images-to-pdf" ? `Photo ${cur.length + 1}.jpg` : `Quarterly report ${cur.length + 1}.pdf`, size: 420_000, type: "application/pdf" }].slice(0, max));
      return;
    }
    try {
      const picked = await pickFiles(def, max > 1);
      if (!picked.length) return;
      setPhase({ kind: "idle" }); setSaved(null);
      setFiles((cur) => (max === 1 ? picked.slice(0, 1) : [...cur, ...picked].slice(0, max)));
    } catch {
      Alert.alert("Couldn't open your files", "Try again, or check that Multies may use Files in your phone's Settings.");
    }
  };
  const move = (i: number, by: number) => setFiles((cur) => { const n = [...cur]; const j = i + by; if (j < 0 || j >= n.length) return cur; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const remove = (i: number) => setFiles((cur) => cur.filter((_, k) => k !== i));

  const run = async () => {
    setTouched(true);
    if (!canRun) { warning(); return; }
    tick();
    setSaved(null);
    const opts = Object.fromEntries(Object.entries(options).filter(([, v]) => v.trim() !== ""));
    try {
      if (fromMail) {
        setPhase({ kind: "uploading", pct: 100 });
        const job = await api.toolFromAttachments(def.op, [fromMail.id], opts);
        setPhase({ kind: "working", job });
      } else if (!auth) {
        // The sample workspace runs nothing: it shows the steps with a pretend result.
        const job = await api.toolFromAttachments(def.op, [], opts);
        setPhase({ kind: "working", job });
      } else {
        setPhase({ kind: "uploading", pct: 0 });
        const job = await uploadJob(auth, def.op, files, opts, (f) => setPhase({ kind: "uploading", pct: Math.round(f * 100) }));
        setPhase({ kind: "working", job });
      }
    } catch (e) {
      warning();
      setPhase({ kind: "failed", message: (e as Error)?.message || "That didn't work. Try again." });
      q.refetch();
    }
  };

  const getFile = async (job: ToolJob): Promise<Saved | null> => {
    if (!auth) { Alert.alert("Sample result", "Files in the sample workspace are examples, so there is nothing to open."); return null; }
    if (saved) return saved;
    setFetching(true);
    try {
      const f = await downloadResult(auth, job);
      setSaved(f);
      return f;
    } catch (e) {
      Alert.alert("Couldn't get the file", (e as Error)?.message || "Try again.");
      return null;
    } finally { setFetching(false); }
  };
  const doOpen = async (job: ToolJob) => { const f = await getFile(job); if (f) await openFile(f).catch(() => Alert.alert("Couldn't open it", "Try Share instead.")); };
  const doShare = async (job: ToolJob) => { const f = await getFile(job); if (f) await shareFile(f).catch(() => {}); };
  const doSave = async (job: ToolJob) => {
    const f = await getFile(job);
    if (!f) return;
    try { if (await saveToPhone(f, job.name, def.contentType || typeForName(job.name))) { success(); Alert.alert("Saved", `${job.name} is saved in the folder you chose.`); } }
    catch { Alert.alert("Couldn't save it", "Pick a folder such as Downloads and try again."); }
  };
  const again = () => { setPhase({ kind: "idle" }); setSaved(null); if (!fromMail) setFiles([]); };

  return (
    <>
      <Stack.Screen options={{ title: def.label }} />
      <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2 }} keyboardShouldPersistTaps="handled" testID={`tool-sheet-${def.op}`}>
        <View style={{ flexDirection: "row", gap: space.md, alignItems: "center" }}>
          <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
            <Icon name={toolIcon(def.op)} size={22} color={colors.brand} />
          </View>
          <Text style={[font.body, { flex: 1, color: colors.muted }]}>{def.blurb}</Text>
        </View>
        {def.note ? <Banner tone="neutral" icon="info" text={def.note} /> : null}
        {usage.blocked ? <Banner tone="warn" icon="alert-circle" text={usage.text} /> : null}

        <Section title={fromMail ? "From your email" : max > 1 ? `Files (${files.length} of up to ${max})` : "File"}>
          {fromMail ? (
            <FileRow name={fromMail.name} icon="paperclip" />
          ) : (
            <>
              {files.map((f, i) => (
                <FileRow key={`${f.uri}-${i}`} name={f.name} size={f.size} index={def.ordered && files.length > 1 ? i + 1 : undefined}
                  onUp={def.ordered && i > 0 && !busy ? () => move(i, -1) : undefined}
                  onDown={def.ordered && i < files.length - 1 && !busy ? () => move(i, 1) : undefined}
                  onRemove={busy ? undefined : () => remove(i)} />
              ))}
              {files.length < max ? (
                <Button label={files.length ? "Add more files" : max > 1 ? "Choose files" : "Choose a file"} icon="plus" variant="secondary" onPress={add} disabled={busy} testID="tool-add-files" />
              ) : null}
              <Text style={font.tiny}>Takes {def.acceptLabel}. Up to {Math.round(Math.min(limits.maxBytes, def.maxBytes ?? Infinity) / (1024 * 1024))} MB{def.maxPages ? ` and ${def.maxPages} pages` : ""}.{def.ordered && files.length > 1 ? " Use the arrows to set the order." : ""}</Text>
              {touched && fileError ? <Text style={{ color: colors.bad, fontSize: 13 }} accessibilityLiveRegion="polite">{fileError}</Text> : null}
            </>
          )}
        </Section>

        {def.options.length ? (
          <Section title="Options">
            {def.options.map((o) => (
              <OptionField key={o.name} o={o} value={options[o.name] ?? ""} disabled={busy} error={touched ? optionErrors[o.name] : null}
                onChange={(v) => setEdited((cur) => ({ ...cur, [o.name]: v }))} />
            ))}
          </Section>
        ) : null}

        {phase.kind === "idle" || phase.kind === "failed" ? (
          <>
            {phase.kind === "failed" ? <Banner tone="bad" icon="alert-circle" text={phase.message} /> : null}
            <Button label={phase.kind === "failed" ? "Try again" : `Run ${def.label.toLowerCase()}`} icon="wrench" onPress={run} disabled={busy || usage.blocked} testID="tool-run" />
            <Text style={[font.tiny, { textAlign: "center" }]}>{usage.text}</Text>
          </>
        ) : null}

        {phase.kind === "uploading" || phase.kind === "working" ? (
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.md }} testID="tool-progress">
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <ActivityIndicator color={colors.brand} />
              <Text style={[font.body, { flex: 1 }]}>{progressText(phase, def)}</Text>
            </View>
            <ProgressBar pct={progressPct(phase)} />
            <Text style={font.tiny}>You can leave this screen open while it works.</Text>
          </View>
        ) : null}

        {phase.kind === "done" ? (
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.md }} testID="tool-done">
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.okSoft, alignItems: "center", justifyContent: "center" }}>
                <Icon name="check" size={20} color={colors.ok} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[font.heading, { fontSize: 16 }]} numberOfLines={2}>{phase.job.name}</Text>
                {resultLine(phase.job) ? <Text style={font.small}>{resultLine(phase.job)}</Text> : null}
              </View>
              {phase.job.result?.verified ? <Badge label="Checked" tone="ok" icon="shield" /> : null}
            </View>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button label="Open" icon="eye" onPress={() => doOpen(phase.job)} loading={fetching} style={{ flex: 1 }} testID="tool-open" />
              {Platform.OS === "android"
                ? <Button label="Save" icon="download" variant="secondary" onPress={() => doSave(phase.job)} disabled={fetching} style={{ flex: 1 }} testID="tool-save" />
                : <Button label="Share" icon="send" variant="secondary" onPress={() => doShare(phase.job)} disabled={fetching} style={{ flex: 1 }} testID="tool-share" />}
            </View>
            <Text style={font.tiny}>{Platform.OS === "ios" ? "Share has Save to Files, Mail, Print and your other apps." : "Open shows it in a viewer that can share it."} The file is deleted from our engine within an hour.</Text>
            <Button label="Run again" variant="ghost" onPress={again} testID="tool-again" />
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

function progressPct(p: Phase): number | null {
  if (p.kind === "uploading") return Math.max(2, p.pct) / 2;
  if (p.kind === "working" && p.job.progress?.total) return 50 + Math.round((p.job.progress.done / p.job.progress.total) * 50);
  return null;
}

function progressText(p: Phase, def: ToolDef): string {
  if (p.kind === "uploading") return p.pct >= 100 ? "Sending" : `Sending ${p.pct}%`;
  if (p.kind === "working") {
    const pr = p.job.progress;
    if (pr?.total) return `Working, page ${Math.min(pr.done + 1, pr.total)} of ${pr.total}`;
    return def.slow ? "Working. This one reads page by page, so it can take a minute." : "Working";
  }
  return "";
}

function ProgressBar({ pct }: { pct: number | null }) {
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.elevated, overflow: "hidden" }} accessibilityRole="progressbar" accessibilityValue={pct === null ? undefined : { min: 0, max: 100, now: pct }}>
      <View style={{ height: 6, width: `${pct ?? 35}%`, backgroundColor: colors.brandFill, borderRadius: 3 }} />
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.3 }} accessibilityRole="header">{title}</Text>
      {children}
    </View>
  );
}

function FileRow({ name, size, icon = "file-text", index, onUp, onDown, onRemove }: { name: string; size?: number; icon?: "file-text" | "paperclip"; index?: number; onUp?: () => void; onDown?: () => void; onRemove?: () => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: 10, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }}
      accessible={!onRemove} accessibilityLabel={`${name}${size ? `, ${bytes(size)}` : ""}`}>
      {index ? <Text style={{ color: colors.subtle, fontSize: 13, width: 18, textAlign: "center", fontVariant: ["tabular-nums"] }}>{index}</Text> : null}
      <Icon name={icon} size={18} color={colors.brand} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.fg, fontSize: 15 }} numberOfLines={1}>{name}</Text>
        {size ? <Text style={font.tiny}>{bytes(size)}</Text> : null}
      </View>
      {onUp ? <IconButton icon="chevron-up" label={`Move ${name} up`} onPress={onUp} /> : null}
      {onDown ? <IconButton icon="chevron-down" label={`Move ${name} down`} onPress={onDown} /> : null}
      {onRemove ? <IconButton icon="x" label={`Remove ${name}`} onPress={onRemove} color={colors.subtle} /> : null}
    </View>
  );
}

function OptionField({ o, value, onChange, disabled, error }: { o: ToolOption; value: string; onChange: (v: string) => void; disabled: boolean; error?: string | null }) {
  if (o.kind === "choice" && o.choices?.length) {
    if (o.choices.length === 1) return <Field label={o.label} value={o.choices[0].label} editable={false} hint={o.help} />;
    return (
      <View style={{ gap: 6 }} pointerEvents={disabled ? "none" : "auto"}>
        <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "500" }}>{o.label}</Text>
        <Segmented label={o.label} value={value || String(o.default ?? o.choices[0].value)} onChange={onChange} options={o.choices.map((c) => ({ id: c.value, label: c.label }))} />
        {o.help ? <Text style={font.tiny}>{o.help}</Text> : null}
      </View>
    );
  }
  return (
    <Field label={o.required ? o.label : `${o.label} (optional)`} value={value} onChangeText={onChange} editable={!disabled} error={error} hint={o.help}
      placeholder={o.placeholder} secureTextEntry={o.kind === "password"} autoCapitalize={o.kind === "text" ? "characters" : "none"} autoCorrect={false}
      keyboardType={o.kind === "int" ? "number-pad" : o.kind === "ranges" ? "numbers-and-punctuation" : "default"}
      multiline={o.kind === "phrases"} style={o.kind === "phrases" ? { minHeight: 96, textAlignVertical: "top", paddingTop: 10 } : undefined}
      maxLength={o.maxLen} testID={`tool-opt-${o.name}`} />
  );
}

