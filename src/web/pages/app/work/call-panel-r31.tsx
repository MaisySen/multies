/**
 * Round 31: the side panel inside a call. Notes (the call's notes doc, made once when a member
 * joins; members edit it, meeting guests read it) and So far (a digest for people who join late:
 * who is here and since when, minutes elapsed, notes headings and to-dos, decisions said in the
 * call's chat). So far opens on its own for someone joining more than 5 minutes after the start.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Clock, Gavel, Hash, NotebookPen, Sparkles, Users, X } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { minutesLabel, shouldShowSoFar } from "@/web/lib/prejoin-prefs";
import { MeetingNotes } from "./meeting-notes";

export interface SoFar {
  meetingId: string; title: string; kind: "digest"; label: "So far"; state: "live" | "waiting" | "ended";
  startedAt: string; elapsedMin: number;
  participants: { name: string; joinedAt: string | null; minutesIn: number | null }[];
  notes: { docId: string; title: string; headings: string[]; agenda: string[]; notes: string[]; todos: { text: string; done: boolean }[] } | null;
  decisions: { text: string; by: string; at: string }[];
  transcript: null; canWriteSummary: boolean; lateJoinMs: number; text: string;
}
interface GuestNotes { notes: { title: string; headings: string[]; agenda: string[]; notes: string[]; todos: { text: string; done: boolean }[] } | null }

export type CallTab = "notes" | "so-far";

/** Members: makes the call's notes doc once (idempotent on the server) as the call starts. */
export function useCallNotesDoc(meetingId: string | undefined, enabled: boolean) {
  const [docId, setDocId] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || !meetingId || asked.current === meetingId) return;
    asked.current = meetingId;
    void api.post<{ docId: string }>(`/meeting-live/${meetingId}/call-notes`, {}).then((r) => {
      setDocId(r.docId);
      void qc.invalidateQueries({ queryKey: ["meeting-notes", meetingId] });
      void qc.invalidateQueries({ queryKey: ["so-far", meetingId] });
    }).catch(() => undefined);
  }, [meetingId, enabled, qc]);
  return docId;
}

const dismissKey = (id: string) => `multies.sofar.dismissed.${id}`;
const wasDismissed = (id: string) => { try { return sessionStorage.getItem(dismissKey(id)) === "1"; } catch { return false; } };

/** Members: the So far digest, polled while the panel is open, and whether it should open on its own. */
export function useSoFar(meetingId: string | undefined, enabled: boolean, open: boolean) {
  return useQuery({
    queryKey: ["so-far", meetingId], enabled: !!meetingId && enabled, staleTime: 10_000,
    refetchInterval: open ? 20_000 : false,
    queryFn: () => api.get<SoFar>(`/meeting-live/${meetingId}/so-far`),
  });
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-4 py-3 first:border-t-0">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-subtle">{icon}{title}</h3>
      {children}
    </section>
  );
}

function Todos({ todos }: { todos: { text: string; done: boolean }[] }) {
  return (
    <ul className="space-y-1 text-[13px]">
      {todos.map((t, i) => (
        <li key={i} className="flex items-start gap-2">
          {t.done ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-label="Done" /> : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" aria-label="Open" />}
          <span className={cn(t.done && "text-muted line-through")}>{t.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function SoFarView({ data, onWrite, writing, written }: { data: SoFar; onWrite?: () => void; writing?: boolean; written?: string | null }) {
  const open = data.notes?.todos ?? [];
  return (
    <div data-testid="so-far" aria-live="polite">
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <span className="inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-[11.5px] font-medium text-muted" title="Built from the call's notes and chat. No model is used.">Digest</span>
        <span className="flex items-center gap-1 text-[12px] text-muted"><Clock className="h-3.5 w-3.5" aria-hidden />{data.elapsedMin} min since the start</span>
      </div>
      {written && <p className="mx-4 mt-3 whitespace-pre-line rounded-xl bg-brand-soft p-3 text-[13px] text-fg" data-testid="so-far-written">{written}</p>}
      <Section icon={<Users className="h-3.5 w-3.5" aria-hidden />} title={`Here now (${data.participants.length})`}>
        {data.participants.length ? (
          <ul className="space-y-1 text-[13px]" data-testid="so-far-people">
            {data.participants.map((p, i) => <li key={i} className="flex items-center justify-between gap-2"><span className="truncate">{p.name}</span><span className="shrink-0 text-[12px] text-subtle">{minutesLabel(p.minutesIn)}</span></li>)}
          </ul>
        ) : <p className="text-[13px] text-muted">Nobody is in the call yet.</p>}
      </Section>
      {data.notes && (data.notes.headings.length > 0 || data.notes.notes.length > 0 || data.notes.agenda.length > 0) && (
        <Section icon={<Hash className="h-3.5 w-3.5" aria-hidden />} title="In the notes">
          {data.notes.headings.length > 0 && <p className="text-[13px] text-muted">{data.notes.headings.join(" · ")}</p>}
          {[...data.notes.agenda, ...data.notes.notes].slice(0, 8).map((l, i) => <p key={i} className="mt-1 text-[13px]">{l}</p>)}
        </Section>
      )}
      {open.length > 0 && <Section icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />} title="To-dos"><Todos todos={open} /></Section>}
      <Section icon={<Gavel className="h-3.5 w-3.5" aria-hidden />} title="Decisions">
        {data.decisions.length ? (
          <ul className="space-y-1.5 text-[13px]">{data.decisions.map((d, i) => <li key={i}>{d.text} <span className="text-[12px] text-subtle">{d.by}</span></li>)}</ul>
        ) : <p className="text-[13px] text-muted">None yet. Start a chat line with "Decision:" to add one.</p>}
      </Section>
      {onWrite && data.canWriteSummary && (
        <div className="border-t border-line px-4 py-3">
          <Button size="sm" variant="secondary" onClick={onWrite} loading={writing} data-testid="so-far-write"><Sparkles className="h-4 w-4" aria-hidden />Write a summary</Button>
          <p className="mt-1 text-[11.5px] text-subtle">Uses your workspace's own AI key.</p>
        </div>
      )}
    </div>
  );
}

function GuestNotesView({ token }: { token: string }) {
  const q = useQuery({ queryKey: ["guest-notes", token], refetchInterval: 30_000, queryFn: () => api.get<GuestNotes>(`/public/meeting-live/${token}/notes`) });
  if (q.isPending) return <div className="p-4"><Skeleton className="h-24" /></div>;
  const n = q.data?.notes;
  if (!n) return <p className="p-4 text-[13px] text-muted">No notes yet. The host's notes show here once they start.</p>;
  return (
    <div className="space-y-2 p-4 text-[13px]" data-testid="guest-notes">
      <p className="text-[11.5px] text-subtle">Read only</p>
      {n.agenda.length > 0 && <div><h3 className="font-semibold">Agenda</h3>{n.agenda.map((l, i) => <p key={i}>{l}</p>)}</div>}
      {n.notes.length > 0 && <div><h3 className="font-semibold">Notes</h3>{n.notes.map((l, i) => <p key={i}>{l}</p>)}</div>}
      {n.todos.length > 0 && <div><h3 className="mb-1 font-semibold">Action items</h3><Todos todos={n.todos} /></div>}
    </div>
  );
}

/**
 * The panel and its two buttons. Members get Notes (editable) and So far; meeting guests get the
 * notes read only. Renders the toolbar (always) and the panel (when open).
 */
export function useCallPanel(meetingId: string | undefined, member: boolean) {
  const [tab, setTab] = useState<CallTab | null>(null);
  const so = useSoFar(meetingId, member, tab === "so-far");
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || !so.data || !meetingId) return;
    auto.current = true;
    if (shouldShowSoFar(so.data.startedAt, Date.now(), so.data.lateJoinMs, wasDismissed(meetingId))) setTab("so-far");
  }, [so.data, meetingId]);
  const close = () => {
    if (tab === "so-far" && meetingId) { try { sessionStorage.setItem(dismissKey(meetingId), "1"); } catch { /* nothing to keep */ } }
    setTab(null);
  };
  return { tab, setTab, close, so };
}

export function CallToolbar({ tab, setTab, member }: { tab: CallTab | null; setTab: (t: CallTab | null) => void; member: boolean }) {
  const btn = (t: CallTab, label: string, icon: ReactNode) => (
    <button type="button" onClick={() => setTab(tab === t ? null : t)} aria-pressed={tab === t} data-testid={`call-tab-${t}`}
      className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none", tab === t ? "bg-brand-soft text-brand" : "text-muted hover:bg-hover hover:text-fg")}>
      {icon}{label}
    </button>
  );
  return (
    <div className="flex items-center gap-1" role="toolbar" aria-label="Call panels">
      {btn("notes", "Notes", <NotebookPen className="h-4 w-4" aria-hidden />)}
      {member && btn("so-far", "So far", <Clock className="h-4 w-4" aria-hidden />)}
    </div>
  );
}

export function CallSidePanel({ meetingId, guestToken, member, tab, onClose, so }: {
  meetingId?: string; guestToken?: string; member: boolean; tab: CallTab; onClose: () => void;
  so: ReturnType<typeof useSoFar>;
}) {
  const [written, setWritten] = useState<string | null>(null);
  const write = useMutation({
    mutationFn: () => api.post<{ summary: string }>(`/meeting-live/${meetingId}/so-far/summary`, {}),
    onSuccess: (r) => setWritten(r.summary), onError: (e) => showError(e as Error),
  });
  return (
    <aside className="flex w-full shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-elevated md:w-[360px] motion-safe:animate-[fade-in_160ms_ease-out]" aria-label={tab === "notes" ? "Call notes" : "So far"} data-testid="call-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-[13px] font-semibold">{tab === "notes" ? "Notes" : "So far"}</h2>
        <button type="button" onClick={onClose} aria-label="Close panel" className="rounded-md p-1 text-subtle hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><X className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "notes"
          ? (member && meetingId ? <div className="p-2"><MeetingNotes meetingId={meetingId} /></div> : guestToken ? <GuestNotesView token={guestToken} /> : null)
          : so.data ? <SoFarView data={so.data} onWrite={() => write.mutate()} writing={write.isPending} written={written} />
          : so.error ? <p className="p-4 text-[13px] text-muted">{(so.error as Error).message}</p>
          : <div className="space-y-2 p-4"><Skeleton className="h-5" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>}
      </div>
    </aside>
  );
}
