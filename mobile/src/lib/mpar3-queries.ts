/** MPAR3: React Query hooks for Calendar, meeting notes, compose extras, folders, bulk select and the shared inbox. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import type { SendInput } from "@/api/types";
import type {
  BulkAction, CalendarEvents, CalendarFeed, CalendarSource, InboxLane, InboxView, MeetingNotes, MeetingRecording, OneItem, OnePage,
  ProviderFolders, SendLaterPreset, Snippet, ThreadComment, ThreadMember, ThreadState, ThreadStatus,
} from "./mpar3";
import { oneRefs } from "./mpar3";

const status = (e: unknown) => (e as { status?: number } | null)?.status;
const retry = (k: number, e: unknown) => { const s = status(e); return !(s && s >= 400 && s < 500) && k < 2; };
/** A 404 means the web has the feature switched off for this workspace (or this person cannot open it). */
export const isOff = (e: unknown) => status(e) === 404 || status(e) === 403;
const enc = encodeURIComponent;

export const mpar3Keys = {
  events: (from: string, to: string) => ["calendar", "events", from, to] as const,
  sources: ["calendar", "sources"] as const,
  feed: ["calendar", "feed"] as const,
  notes: (id: string) => ["meeting-notes", id] as const,
  recordings: (id: string) => ["meeting-recordings", id] as const,
  snippets: ["mail-snippets"] as const,
  folders: (c: string) => ["mail", "provider-folders", c] as const,
  threadState: (id: string) => ["thread-state", id] as const,
  comments: (id: string) => ["thread-comments", id] as const,
  one: (lane: string, view: string) => ["one-inbox", lane, view] as const,
};

// ---------------------------------------------------------------- calendar

export function useCalendarEvents(from: string, to: string) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar3Keys.events(from, to), mode], retry, networkMode: "always", staleTime: 30_000,
    queryFn: () => transport.request<CalendarEvents>("GET", `/calendar/events?from=${enc(from)}&to=${enc(to)}`) });
}
export function useCalendarSources() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar3Keys.sources, mode], retry, networkMode: "always", queryFn: async () => (await transport.request<{ data: CalendarSource[] }>("GET", "/calendar/sources")).data });
}
export function useCalendarFeed() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar3Keys.feed, mode], retry, networkMode: "always", queryFn: async () => (await transport.request<{ feed: CalendarFeed }>("GET", "/calendar/feed")).feed });
}
export function useCalendarActions() {
  const { transport, mode } = useSession();
  const qc = useQueryClient();
  const again = () => { void qc.invalidateQueries({ queryKey: ["calendar"] }); };
  return {
    toggleSource: useMutation({ mutationFn: (p: { id: string; enabled: boolean }) => transport.request<{ source: CalendarSource }>("PATCH", `/calendar/sources/${enc(p.id)}`, { enabled: p.enabled }), onSettled: again }),
    removeSource: useMutation({ mutationFn: (id: string) => transport.request<{ ok: true }>("DELETE", `/calendar/sources/${enc(id)}`), onSettled: again }),
    addIcs: useMutation({ mutationFn: (p: { url: string; name?: string }) => transport.request<{ source: CalendarSource }>("POST", "/calendar/sources", { kind: "ics", url: p.url.trim(), ...(p.name?.trim() ? { name: p.name.trim() } : {}) }), onSettled: again }),
    /** Makes a new private link (the old one stops working); the answer carries the link once. */
    resetFeed: useMutation({ mutationFn: (includeTasks: boolean) => transport.request<{ feed: CalendarFeed }>("POST", "/calendar/feed", { includeTasks }),
      onSuccess: (r) => qc.setQueryData([...mpar3Keys.feed, mode], r.feed) }),
    feedTasks: useMutation({ mutationFn: (includeTasks: boolean) => transport.request<{ feed: CalendarFeed }>("PATCH", "/calendar/feed", { includeTasks }), onSettled: again }),
    stopFeed: useMutation({ mutationFn: () => transport.request<{ ok: true }>("DELETE", "/calendar/feed"), onSettled: again }),
    moveMeeting: useMutation({ mutationFn: (p: { id: string; title?: string; startsAt?: string; durationMin?: number }) =>
      transport.request<unknown>("PATCH", `/meetings/${enc(p.id)}`, { ...(p.title ? { title: p.title } : {}), ...(p.startsAt ? { startsAt: p.startsAt } : {}), ...(p.durationMin ? { durationMin: p.durationMin } : {}) }),
      onSettled: () => { again(); void qc.invalidateQueries({ queryKey: ["meetings"] }); } }),
    moveTask: useMutation({ mutationFn: (p: { id: string; due: string | null }) => transport.request<unknown>("PATCH", `/tasks/${enc(p.id)}`, { due: p.due }),
      onSettled: () => { again(); void qc.invalidateQueries({ queryKey: ["tasks"] }); } }),
  };
}

// ---------------------------------------------------------------- meeting notes and transcripts

export function useMeetingNotes(id: string) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar3Keys.notes(id), mode], retry, networkMode: "always", enabled: !!id, queryFn: () => transport.request<MeetingNotes>("GET", `/meeting-notes/${enc(id)}`) });
}
export function useMeetingRecordings(id: string) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar3Keys.recordings(id), mode], retry, networkMode: "always", enabled: !!id,
    queryFn: async () => (await transport.request<{ recordings: MeetingRecording[] }>("GET", `/meetings/${enc(id)}/recordings`)).recordings });
}

// ---------------------------------------------------------------- compose extras

export function useSnippets(enabled: boolean) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar3Keys.snippets, mode], retry, enabled, networkMode: "always",
    queryFn: async () => (await transport.request<{ snippets: Snippet[] }>("GET", "/mail-snippets")).snippets ?? [] });
}
export function useRenderSnippet() {
  const { transport } = useSession();
  return useMutation({ mutationFn: (p: { id: string; to?: string; mailboxId?: string; threadId?: string }) =>
    transport.request<{ body: string; subject?: string | null }>("POST", `/mail-snippets/${enc(p.id)}/render`, { to: p.to || null, mailboxId: p.mailboxId || null, threadId: p.threadId || null }) });
}
export function useSendLater() {
  const { transport } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { message: SendInput; when: { preset: SendLaterPreset } | { local: string }; key: string }) =>
      transport.request<unknown>("POST", "/mail-schedules/send", { message: p.message, ...p.when }, { idempotencyKey: p.key }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["messages"] }); },
  });
}
export interface SecretMade { id: string; url: string | null }
export function useCreateSecret() {
  const { transport } = useSession();
  return useMutation({ mutationFn: (b: { ciphertext: string; label: string | null; maxViews: number; expiresInSeconds: number }) =>
    transport.request<{ secret: SecretMade }>("POST", "/tools/secrets", { kind: "text", passphrase: false, notify: true, ...b }) });
}

// ---------------------------------------------------------------- folders and bulk

export function useProviderFolders(connectionId: string | null | undefined) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar3Keys.folders(connectionId ?? ""), mode], retry, enabled: !!connectionId, networkMode: "always", staleTime: 5 * 60_000,
    queryFn: () => transport.request<ProviderFolders>("GET", `/connections/${enc(connectionId!)}/folders`) });
}
export function useBulkMail() {
  const { transport } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { ids: string[]; action: BulkAction; to?: string }) => transport.request<{ ok?: boolean; updated?: number; count?: number }>("POST", "/mail/messages/bulk", b),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["messages"] }); void qc.invalidateQueries({ queryKey: ["overview"] }); void qc.invalidateQueries({ queryKey: ["counts"] }); },
  });
}

// ---------------------------------------------------------------- shared inbox

export function useThreadState(threadId: string | undefined) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar3Keys.threadState(threadId ?? ""), mode], retry: (k, e) => !isOff(e) && retry(k, e), enabled: !!threadId, networkMode: "always",
    queryFn: () => transport.request<{ state: ThreadState; members: ThreadMember[] }>("GET", `/threads/${enc(threadId!)}/state`) });
}
export function useThreadActions(threadId: string) {
  const { transport, mode } = useSession();
  const qc = useQueryClient();
  const key = [...mpar3Keys.threadState(threadId), mode];
  const put = (r: { state: ThreadState }) => qc.setQueryData(key, (old: { state: ThreadState; members: ThreadMember[] } | undefined) => (old ? { ...old, state: r.state } : old));
  return {
    assign: useMutation({ mutationFn: (userId: string | null) => transport.request<{ state: ThreadState }>("POST", `/threads/${enc(threadId)}/assign`, { userId }), onSuccess: put }),
    status: useMutation({ mutationFn: (s: ThreadStatus) => transport.request<{ state: ThreadState }>("POST", `/threads/${enc(threadId)}/status`, { status: s }), onSuccess: put }),
  };
}
export function useThreadComments(threadId: string | undefined, enabled: boolean) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar3Keys.comments(threadId ?? ""), mode], retry, enabled: !!threadId && enabled, networkMode: "always",
    queryFn: () => transport.request<{ threadId: string; comments: ThreadComment[] }>("GET", `/threads/${enc(threadId!)}/comments`) });
}
export function useCommentActions(threadId: string) {
  const { transport, mode } = useSession();
  const qc = useQueryClient();
  const again = () => { void qc.invalidateQueries({ queryKey: [...mpar3Keys.comments(threadId), mode] }); };
  return {
    add: useMutation({ mutationFn: (body: string) => transport.request<{ comment: ThreadComment }>("POST", `/threads/${enc(threadId)}/comments`, { body }), onSettled: again }),
    remove: useMutation({ mutationFn: (id: string) => transport.request<unknown>("DELETE", `/threads/${enc(threadId)}/comments/${enc(id)}`), onSettled: again }),
  };
}

export function useOneInbox(lane: InboxLane, view: InboxView, enabled = true) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar3Keys.one(lane, view), mode], retry: (k, e) => !isOff(e) && retry(k, e), enabled, networkMode: "always", refetchInterval: 60_000,
    queryFn: () => transport.request<OnePage>("GET", `/one-inbox?lane=${lane}&view=${view}`) });
}
export function useOneAct() {
  const { transport } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { action: "done" | "undone" | "read" | "unread" | "snooze"; items: OneItem[]; preset?: SendLaterPreset }) =>
      transport.request<unknown>("POST", "/one-inbox/act", { action: p.action, items: oneRefs(p.items), ...(p.preset ? { preset: p.preset } : {}) }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["one-inbox"] }); },
  });
}
