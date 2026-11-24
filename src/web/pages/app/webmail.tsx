import { useMediaQuery } from "@/web/lib/use-compact";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels"; // R79 (MIT)
import { panelStorage, useLayout, useLayoutGeneration } from "@/web/lib/layout-prefs"; // R79
import { InboxZeroArt, MailFolderArt, NoSearchResultsArt } from "@/web/components/illustrations";
import { FreeAddressCard, useFreeAddress } from "@/web/components/free-address"; // R74 (MB-212)
import { MailSyncBanner } from "@/web/components/mail-sync-progress";
import { folderEmpty } from "@/web/lib/empty-copy-r36"; // R36
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applyMailAction, type MailAction, type MailListData } from "@/web/lib/optimistic-mail"; // R30
import { SwipeRow } from "@/web/components/ui/swipe-row";
import { useWindowedList } from "@/web/lib/use-windowed-list"; // R43 (MB-210)
import { IconAgent, IconArchive, IconArrowLeft, IconAttachment, IconBlock, IconClose, IconCompose, IconFile, IconFileEdit, IconForward, IconInbox, IconMove, IconReply, IconSearch, IconSend, IconShieldAlert, IconShieldCheck, IconSparkle, IconStar, IconTrash, type IconComponent, IconSnooze, IconTag, IconWorkflow } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api, ApiError, errorMessage } from "@/web/lib/api";
import { AI_OFF_MESSAGE } from "@/shared/ask-td1";
import { qk, useConfig } from "@/web/lib/queries";
import { MailBodyLazy } from "@/web/components/lang-tools-r116-lazy"; // R116
import type { Folder, Message, MailboxOverview, MessageListItem } from "@/web/lib/types";
import { Avatar, EmptyState, Kbd, Skeleton } from "@/web/components/ui/misc";
import { PHONE_PICK, Select } from "@/web/components/ui/input";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { formatBytes, fullDate, initials, mailDate } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { HtmlBody, TextBody } from "./mail/html-body";
import { Compose, type ComposeDraft } from "./mail/compose";
import { ThreadPresenceLine } from "./inbox-presence";
import { useReopenedDrafts } from "@/web/lib/undo-send";
import { useLiveMail } from "@/web/lib/live-mail";
import { ProviderFolderNav, moveTargets, useProviderFolders } from "./mail/provider-folders";
import { InvoiceReminderDialog } from "./mail/invoice-reminder";
import { BYO_AI_LINE, useAiStatus } from "./ai-section";
import { AI_KEY_FIX_PATH } from "@/shared/ai-connect-ai2"; // QUAL1

/** QUAL1: the codes an AI route answers when the provider refused the workspace's key, its credit or its model. */
const AI_KEY_CODES = new Set(["ai_key_refused", "ai_no_credit", "ai_model_unavailable"]);
import { MakeTask, MakeTaskBarButton } from "./work/make-task";
import { AttachmentTools } from "./mail/attachment-tools"; // Tools P1
import { BatchTools } from "@/web/components/tools/batch-tools"; // Tools P2
import { forgetOpenReply, openReplyDraft } from "@/web/lib/draft-autosave"; // R67 (MB-244)
import { takePendingCompose } from "@/web/lib/compose-files"; // Tools P2: attachments handed to a new email
import { setFocus, useCommandHandlers } from "@/web/lib/commands";
import { SCHEDULE_VIEWS, isScheduleView, ReturnedStrip, ScheduleListView, SnoozeMenu, useScheduleList, type ScheduleItem } from "./mail/schedules";
import { DEFAULT_SPLIT, EditSplitsDialog, ReadStatusLine, SplitTabs, stepSplit, useSplits } from "./mail/splits"; // R31
import { LabelChips, LabelMenu, MAIL_DRAG_TYPE, MoveToTabMenu, storeDefaultTab, storedDefaultTab, useLabelEdit, useLabels, useTeachTab } from "./mail/tabs-r85"; // R85
import { registerMailActions } from "@/web/lib/mail-actions"; // R31
import type { ReadStatus } from "@/shared/mail-splits";
import { BulkBar, RowCheck } from "./mail/bulk-bar"; // R32
import { Dialog } from "@/web/components/ui/dialog";
import { jobActionFor, jobConfirmWords, needsConfirm, type JobAction } from "@/web/lib/bulk-confirm-r34"; // R34
import { newJobId, useBulkOps, type JobBody } from "./mail/bulk-ops-r33"; // R33
import { ArchiveOlderSheet } from "./mail/archive-older-r45"; // R45 (MB-137)
import { archiveOlderOffered, emptyInboxTitle } from "./mail/archive-older-offer"; // R46
import { dropCopies, dropMailCopiesNotIn, withOfflineCopy } from "@/web/lib/offline-lists"; // R33 offline
import { SNOOZE_WORDS, emptySelection, prune, selectAll, selectRange, setSelectionCount, toggleOne, undoPlan, UNDO_MS, type BulkCall, type Selection } from "@/web/lib/mail-selection"; // R32
import { LoadError } from "@/web/components/load-error-t1g";
import { tl, tr } from "@/web/i18n"; // R104, POL4 (HQ MB-356)
import { canChangeMail, canReplyIn, isGone, mailCopyPrefix, pickMailbox } from "@/web/lib/mail-level-priv1b"; // PRIV1b (P66)

type View = Folder | "starred" | "snoozed" | "scheduled" | `f:${string}`;
const FOLDER_UI: { id: View; label: string; icon: IconComponent }[] = [
  { id: "inbox", get label() { return tl("mailfolder", "Inbox"); }, icon: IconInbox },
  { id: "starred", get label() { return tl("mailfolder", "Starred"); }, icon: IconStar },
  { id: "sent", get label() { return tl("mailfolder", "Sent"); }, icon: IconSend },
  { id: "drafts", get label() { return tl("mailfolder", "Drafts"); }, icon: IconFileEdit },
  { id: "archive", get label() { return tl("mailfolder", "Archive"); }, icon: IconArchive },
  { id: "spam", get label() { return tl("mailfolder", "Spam"); }, icon: IconBlock },
  { id: "trash", get label() { return tl("mailfolder", "Trash"); }, icon: IconTrash },
];

export function WebmailPage() {
  const [params, setParams] = useSearchParams();
  // R79: the reading pane (right, bottom or off) and its saved divider, on screens wide enough for two panes.
  const wideMail = useMediaQuery("(min-width: 1024px)");
  const { mailPane } = useLayout();
  const layoutGen = useLayoutGeneration();
  const paned = wideMail && mailPane !== "off";
  const mailLayout = useDefaultLayout({ id: `mail-${mailPane}`, storage: panelStorage });
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: qk.overview, queryFn: async () => (await api.get<{ mailboxes: MailboxOverview[] }>("/mail/overview")).mailboxes, refetchInterval: 30_000 });
  const mailboxes = useMemo(() => overview.data ?? [], [overview.data]);
  useLiveMail(mailboxes.some((m) => m.connected));
  // PRIV1b (WP1): a share that ended while this person was in another mailbox only drops out of the overview; its
  // stored offline list copy goes too, so it can't come back offline.
  useEffect(() => { if (overview.data) void dropMailCopiesNotIn(overview.data.map((m) => m.id)); }, [overview.data]);
  const busiest = [...mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0];
  // PRIV1b (P66, WC1): a ?mailbox= this person can't open (not in their overview) is not used; the busiest one opens
  // instead. Before the overview answers (or offline, where it has no copy) the URL's mailbox loads straight away.
  const wantedBox = params.get("mailbox");
  const mailboxId = pickMailbox(wantedBox, overview.data, busiest?.id);
  const canChange = canChangeMail(mailboxes.find((m) => m.id === mailboxId));
  const folder = (params.get("folder") ?? "inbox") as View;
  const q = params.get("q") ?? "";
  const selected = params.get("m");
  // R85: a label view (any folder) narrows the list to threads with that label.
  const label = params.get("label") ?? "";
  // R31: Inbox tabs (Important, Other, your splits). Only Inbox has them, and not while searching. R85: the tab style
  // decides where Inbox opens (Important or Primary, or no tabs); the last one seen is remembered so the first read needs no wait.
  const splitsOn = folder === "inbox" && !q && !label;
  const splits = useSplits(mailboxId, splitsOn);
  const defaultTab = splits.data ? splits.data.defaultTab ?? DEFAULT_SPLIT : storedDefaultTab();
  useEffect(() => { if (splits.data?.defaultTab !== undefined) storeDefaultTab(splits.data.defaultTab); }, [splits.data?.defaultTab]);
  const split = splitsOn ? params.get("split") ?? defaultTab : "";
  const [editSplits, setEditSplits] = useState(false);
  const [search, setSearch] = useState(q);
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => setSearch(q), [q]);

  const setParam = useCallback((patch: Record<string, string | null>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      return next;
    }, { replace: patch.m === undefined });
  }, [setParams]);

  const splitTabs = useMemo(() => splits.data?.tabs ?? [], [splits.data]);
  const teach = useTeachTab();
  const labels = useLabels();
  const navigate = useNavigate();
  const list = useInfiniteQuery({
    queryKey: ["mail", "list", mailboxId, folder, q, split, label],
    enabled: !!mailboxId && (!!q || !isScheduleView(folder)),
    initialPageParam: "",
    // R33: the first page of each mailbox folder keeps a stored copy for offline (offline-lists.ts); search does not.
    networkMode: "offlineFirst",
    queryFn: ({ pageParam }) => {
      const read = () => api.get<{ messages: MessageListItem[]; nextCursor: string | null; asOf?: string }>(
        `/mail/messages?${new URLSearchParams({ mailboxId, ...(q ? { q } : folder.startsWith("f:") ? { remote: folder } : { folder }), ...(split ? { split } : {}), ...(label ? { label } : {}), ...(pageParam ? { cursor: pageParam } : {}) })}`,
      );
      return !pageParam && !q && !label ? withOfflineCopy(`mail:${mailboxId}:${folder}:${split}`, read)() : read();
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  // PRIV1b (P66): a 404 here means the share was taken back or left: the mailbox leaves the screen (its list too) and
  // the overview is read again, instead of the last list staying up while every refresh fails quietly.
  const goneBox = list.error && isGone(list.error) ? mailboxId : "";
  useEffect(() => {
    if (!goneBox) return;
    qc.removeQueries({ queryKey: ["mail", "list", goneBox] });
    void dropCopies(mailCopyPrefix(goneBox)); // PRIV1b (WC4): its stored offline copy goes too
    qc.setQueryData<MailboxOverview[]>(qk.overview, (d) => d?.filter((m) => m.id !== goneBox));
    void qc.invalidateQueries({ queryKey: qk.overview });
    setParams((p) => { const n = new URLSearchParams(p); if (n.get("mailbox") === goneBox) n.delete("mailbox"); n.delete("m"); return n; }, { replace: true });
  }, [goneBox, qc, setParams]);
  // Round 20: snoozed threads and reminders that came back sit on top of Inbox, marked, until opened.
  const returned = useScheduleList("returned", mailboxId, folder === "inbox" && !q);
  const returnedItems = useMemo(() => (folder === "inbox" && !q ? returned.data ?? [] : []), [returned.data, folder, q]);
  const items = useMemo(() => {
    const all = list.data?.pages.flatMap((p) => p.messages) ?? [];
    const lifted = new Set(returnedItems.map((r) => r.threadId));
    return lifted.size ? all.filter((m) => !lifted.has(m.threadId)) : all;
  }, [list.data, returnedItems]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"] });
  const listKey = ["mail", "list", mailboxId, folder, q, split, label];
  const act = useMutation({
    mutationFn: ({ ids, action, to, preset }: { ids: string[]; action: string; to?: string; preset?: string; quiet?: boolean }) => api.post("/mail/messages/bulk", { ids, action, ...(to ? { to } : {}), ...(preset ? { preset } : {}) }),
    // R30: optimistic. The list changes at once; a refusal puts it back and says why.
    onMutate: async ({ ids, action }) => {
      await qc.cancelQueries({ queryKey: listKey });
      const before = qc.getQueryData<MailListData>(listKey);
      qc.setQueryData<MailListData>(listKey, (d) => applyMailAction(d, ids, action as MailAction, folder, !!q));
      return { before };
    },
    onSuccess: (_r, v) => {
      if (v.quiet) return; // R32: bulk actions show their own toast with Undo
      const labels: Record<string, string> = { archive: "Archived", trash: "Moved to trash", spam: "Marked as spam", inbox: "Moved to inbox", delete: "Deleted forever", move: v.to ? `Moved to ${v.to.slice(2)}` : "Moved" };
      if (labels[v.action]) toast.success(labels[v.action]);
    },
    // R33: a bulk action (quiet) says it failed in its own toast, with Retry.
    onError: (e, v, ctx) => { if (ctx?.before) qc.setQueryData(listKey, ctx.before); if (!v.quiet) showError(e); },
    onSettled: () => { void refresh(); },
  });

  const open = (id: string | null) => setParam({ m: id });

  // R32: multi-select. X toggles the open row, Shift+X or Shift+click selects a range, Cmd/Ctrl+A selects every
  // visible row, Escape clears. E, H, # and U act on the whole selection; every action can be undone for 8 seconds.
  const [sel, setSel] = useState<Selection>(emptySelection);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<BulkCall | null>(null);
  const rowIds = useMemo(() => items.map((m) => m.id), [items]);
  // R43 (MB-210): with Load more a folder can reach thousands of rows; only the rows on screen are rendered.
  const mailListRef = useRef<HTMLUListElement>(null);
  const mailWin = useWindowedList({ count: items.length, estimate: 86, listRef: mailListRef });
  const rowKey = rowIds.join(",");
  useEffect(() => { setSel(emptySelection()); setSnoozeOpen(false); }, [mailboxId, folder, q, split]);
  useEffect(() => { setSel((s) => prune(s, rowKey ? rowKey.split(",") : [])); }, [rowKey]);
  useEffect(() => { setSelectionCount(sel.ids.length); }, [sel.ids.length]);
  useEffect(() => () => setSelectionCount(0), []);
  // R33: one toast per bulk action with Cancel, Undo, Undoing and Undone (mail/bulk-ops-r33.ts).
  const ops = useBulkOps(UNDO_MS);
  const runUndo = ops.undoLatest;
  // R33: "select all" past what is loaded: every conversation in this folder or search, minus the unticked ones,
  // runs as ONE server job. null when off; the array is the ids unticked after choosing it.
  const [everything, setEverything] = useState<string[] | null>(null);
  useEffect(() => { setEverything(null); }, [mailboxId, folder, q, split]);
  useEffect(() => { if (!sel.ids.length) setEverything(null); }, [sel.ids.length]);
  const jobScope = (): JobBody["scope"] | null => {
    if (q) return { mailboxId, q };
    if (folder.startsWith("f:")) return { mailboxId, remote: folder };
    if (["inbox", "archive", "spam", "trash", "starred"].includes(folder)) return { mailboxId, folder, ...(split ? { split } : {}) };
    return null;
  };
  const folderTotal = (): number | null => {
    if (q || split || folder.startsWith("f:") || folder === "starred") return null;
    const box = mailboxes.find((m) => m.id === mailboxId);
    return box?.folders[folder as Folder]?.total ?? null;
  };
  // R34: a select-all job over more than BIG_JOB messages (or an unknown total with more pages) asks first.
  const [confirmJob, setConfirmJob] = useState<{ action: JobAction; extra: { to?: string; when?: JobBody["when"] }; label?: string; title: string; description: string; button: string } | null>(null);
  // R34: Enter confirms the big-job dialog wherever focus sits in it (Esc cancels through the dialog itself).
  const confirmRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!confirmJob) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      confirmRef.current();
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [confirmJob]);
  const runJob = (action: JobAction, extra: { to?: string; when?: JobBody["when"] } = {}, label?: string, confirmed = false) => {
    if (!canChange) return; // PRIV1b (P66): a read share changes nothing
    const scope = jobScope();
    const exclude = everything ?? [];
    if (!scope) return;
    const known = folderTotal();
    const expected = known !== null ? Math.max(0, known - exclude.length) : null;
    if (!confirmed && needsConfirm(expected, !!list.hasNextPage)) {
      const where = q ? `“${q}”` : FOLDER_UI.find((f) => f.id === folder)?.label ?? "this folder";
      const said = action === "snooze" ? label?.replace(/^until /, "") : label;
      setConfirmJob({ action, extra, label, ...jobConfirmWords(action, expected, where, said) });
      return;
    }
    // The ceiling is when the list on screen was read (server clock); mail that reached Multies after that is left
    // alone. Older servers: the newest arrival among the loaded rows.
    const seen = list.data?.pages[0]?.asOf ?? items.reduce((m, i) => (i.receivedAt && i.receivedAt > m ? i.receivedAt : m), "");
    const body: JobBody = { client_job_id: newJobId(), action, scope, exclude_ids: exclude, max_received_at: seen || new Date().toISOString(), ...extra };
    const loaded = rowIds.filter((id) => !exclude.includes(id));
    // Optimistic: the loaded rows change at once; the job does the rest on the server.
    if (action !== "move") qc.setQueryData<MailListData>(listKey, (d) => applyMailAction(d, loaded, action as MailAction, folder, !!q));
    const total = folderTotal();
    setSel(emptySelection());
    setEverything(null);
    if (selected && loaded.includes(selected) && action !== folder && !["read", "unread", "star", "unstar"].includes(action)) open(null);
    ops.run({ kind: "job", body, count: total !== null ? Math.max(0, total - exclude.length) : loaded.length, onSettled: () => { void refresh(); } }, { action, count: total !== null ? Math.max(0, total - exclude.length) : loaded.length, folderLabel: label });
  };
  // R45 (MB-137): "Archive older mail", one server job over the whole Inbox for mail dated before the cut.
  const [olderOpen, setOlderOpen] = useState(false);
  const listAsOf = (): string => list.data?.pages[0]?.asOf ?? items.reduce((m, i) => (i.receivedAt && i.receivedAt > m ? i.receivedAt : m), "");
  const runArchiveOlder = (before: string, count: number) => {
    const body: JobBody = { client_job_id: newJobId(), action: "archive", scope: { mailboxId, folder: "inbox", before }, exclude_ids: [], max_received_at: listAsOf() || new Date().toISOString() };
    const loaded = items.filter((i) => i.date < before).map((i) => i.id);
    qc.setQueryData<MailListData>(listKey, (d) => applyMailAction(d, loaded, "archive", folder, false));
    if (selected && loaded.includes(selected)) open(null);
    ops.run({ kind: "job", body, count, onSettled: () => { void refresh(); } }, { action: "archive", count, folderLabel: "Archive" });
  };
  confirmRef.current = () => { const c = confirmJob; setConfirmJob(null); if (c) runJob(c.action, c.extra, c.label, true); };
  const runBulk = (partial: Omit<BulkCall, "ids">, folderLabel?: string, confirmed = false) => {
    // R34: snooze, move and delete (to Trash, undoable) run as the server job too when everything is chosen.
    if (!canChange) return; // PRIV1b (P66)
    const jobAction = everything ? jobActionFor(partial.action, folder) : null;
    if (jobAction) {
      const p = partial as Omit<BulkCall, "ids"> & { to?: string; preset?: "later_today" | "tomorrow" | "next_week"; at?: string; local?: string };
      const extra = jobAction === "move" ? { to: p.to } : jobAction === "snooze" ? { when: { preset: p.preset, at: p.at, local: p.local } } : {};
      runJob(jobAction, extra, jobAction === "snooze" && p.preset ? SNOOZE_WORDS[p.preset] : folderLabel);
      return;
    }
    const ids = everything ? rowIds.filter((id) => !everything.includes(id)) : sel.ids;
    if (!ids.length) return;
    const call: BulkCall = { ...partial, ids };
    if (call.action === "delete" && !confirmed) { setConfirmDelete(call); return; }
    const plan = undoPlan(call, items);
    setSel(emptySelection());
    if (selected && ids.includes(selected) && ["archive", "inbox", "spam", "trash", "delete", "move", "snooze"].includes(call.action) && call.action !== folder) open(null);
    ops.run({ kind: "ids", call, plan, apply: (c) => act.mutateAsync({ ...c, quiet: true }), folderLabel }, { action: call.action, count: ids.length, folderLabel: call.action === "snooze" && call.preset ? SNOOZE_WORDS[call.preset] : folderLabel });
  };
  // R35: one row swiped on a phone. The same undoable path as a bulk action on one id, so the toast offers Undo.
  const swipeAct = (id: string, action: "archive" | "snooze") => {
    const partial = (action === "snooze" ? { action: "snooze", preset: "tomorrow" } : { action: folder === "archive" ? "inbox" : "archive" }) as Omit<BulkCall, "ids">;
    const call = { ...partial, ids: [id] } as BulkCall;
    const plan = undoPlan(call, items);
    if (selected === id) open(null);
    ops.run({ kind: "ids", call, plan, apply: (c) => act.mutateAsync({ ...c, quiet: true }) }, { action: call.action, count: 1, folderLabel: action === "snooze" ? SNOOZE_WORDS.tomorrow : undefined });
  };
  const toggleRow = (id: string, shift: boolean) => {
    // R33: with everything chosen, a click unticks (or ticks back) one row; the job leaves unticked rows alone.
    if (everything) { setEverything(everything.includes(id) ? everything.filter((x) => x !== id) : [...everything, id]); return; }
    setSel((s) => (shift ? selectRange(s, id, rowIds) : toggleOne(s, id, rowIds)));
  };
  const latestSel = useRef({ sel, rowIds, current: null as MessageListItem | null, compose: !!compose, runUndo });
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const l = latestSel.current;
      const t = e.target as HTMLElement | null;
      if (l.compose || e.defaultPrevented || !t || t.closest?.("input, textarea, select, [contenteditable=true], [role=dialog], dialog")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && !e.altKey && !e.shiftKey && k === "z") { if (l.runUndo()) e.preventDefault(); return; }
      if (mod && !e.altKey && !e.shiftKey && k === "a" && l.rowIds.length) { e.preventDefault(); e.stopImmediatePropagation(); setSel(selectAll(l.rowIds)); return; }
      if (!mod && !e.altKey && e.shiftKey && k === "x" && l.current) { e.preventDefault(); e.stopImmediatePropagation(); setSel((s) => selectRange(s, l.current!.id, l.rowIds)); return; }
      if (e.key === "Escape" && l.sel.ids.length) { e.preventDefault(); e.stopImmediatePropagation(); setSel(emptySelection()); }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);
  const idx = items.findIndex((i) => i.id === selected);
  const current = idx >= 0 ? items[idx] : null;
  latestSel.current = { sel, rowIds, current, compose: !!compose, runUndo };
  const hasSel = sel.ids.length > 0;
  const move = (action: string) => {
    if (!current || !canChange) return; // PRIV1b (P66)
    const next = items[idx + 1] ?? items[idx - 1];
    // R37: E and # on the open message take the same undoable path as a swipe or a bulk action on one id,
    // so Cmd+Z (and the toast's Undo) bring it back, as the shortcuts sheet promises. Same single write as before.
    const call = { action, ids: [current.id] } as BulkCall;
    const plan = undoPlan(call, items);
    ops.run({ kind: "ids", call, plan, apply: (c) => act.mutateAsync({ ...c, quiet: true }) }, { action: call.action, count: 1 });
    open(next?.id ?? null);
  };
  // Undo send (or a failed send) puts the message back into Compose, exactly as it was.
  // If another message is open in Compose, the taken back one waits and opens when that one closes.
  const waiting = useRef<ComposeDraft[]>([]);
  useReopenedDrafts<ComposeDraft>((d) => {
    if (!compose) { setCompose(d); return; }
    waiting.current.push(d);
    toast.info("Message taken back", { description: "It opens when you close the message you're writing." });
  });
  const closeCompose = () => setCompose(waiting.current.shift() ?? null);
  const openReturned = (it: ScheduleItem) => {
    if (!it.messageId) return;
    void api.post("/mail-schedules/opened", { messageId: it.messageId }).then(() => qc.invalidateQueries({ queryKey: ["mail", "schedules"] }));
    open(it.messageId);
  };
  // Edit a scheduled send: it comes out of Scheduled and back into Compose, to send or schedule again.
  const editScheduled = async (it: ScheduleItem) => {
    if (!it.send) return;
    try { await api.del(`/mail-schedules/${it.id}`); } catch (e) { showError(e as Error); return; }
    void qc.invalidateQueries({ queryKey: ["mail"] });
    setCompose({ mailboxId: it.mailboxId, to: it.send.to.join(", "), cc: it.send.cc.join(", ") || undefined, bcc: it.send.bcc.join(", ") || undefined, subject: it.send.subject, text: it.send.text, inReplyToId: it.send.inReplyToId ?? undefined });
    toast.info("Taken out of Scheduled", { description: "Edit it, then send it or schedule it again." });
  };
  const startCompose = (d?: Partial<ComposeDraft>) => setCompose({ mailboxId: mailboxId || mailboxes[0]?.id || "", to: "", subject: "", text: "", ...d });
  // ?compose=1 (from the setup checklist or the command palette) opens a new message once mailboxes load.
  // ?compose=name@example.com (from a contact page) opens it addressed to that person.
  const composeParam = params.get("compose");
  const handedFiles = useRef<ReturnType<typeof takePendingCompose>>(null);
  // Tools P2: ?compose=files opens a new message carrying what "Attach to a new email" handed over (lib/compose-files:
  // Tools result tokens and local files in one row); ?compose=tools is the older name. ?subject= and ?text= prefill
  // a new message (share links and signing open it with the link in).
  const wantsCompose = composeParam === "1" || composeParam === "files" || composeParam === "tools" || !!composeParam?.includes("@");
  useEffect(() => {
    if (!wantsCompose) { handedFiles.current = null; return; }
    if (!mailboxes.length) return;
    const handed = composeParam === "files" || composeParam === "tools" ? (handedFiles.current ??= takePendingCompose()) : null;
    setCompose({
      mailboxId: mailboxId || mailboxes[0].id,
      to: composeParam?.includes("@") ? composeParam : handed?.to ?? "",
      subject: handed?.subject ?? (params.get("subject") ?? "").slice(0, 300),
      text: handed?.text ?? (params.get("text") ?? "").slice(0, 5000),
      ...(handed?.files?.length ? { files: handed.files } : {}),
      ...(handed?.toolFiles?.length ? { toolFiles: handed.toolFiles } : {}),
    });
    setParams((p) => { const n = new URLSearchParams(p); n.delete("compose"); n.delete("subject"); n.delete("text"); return n; }, { replace: true });
  }, [wantsCompose, composeParam, mailboxes, mailboxId, setParams, params]);

  // R31: mail keys come from the one command registry (lib/commands/modules/mail.ts); this page binds them.
  // R32: a selection counts as focus too, so E, H, # and U reach the page with no message open.
  const focusId = selected ?? sel.ids[0] ?? null;
  // R32: J, K and X typed quickly run before the page re-renders, so the open row is tracked here as well
  // (otherwise "x j x" toggled the same row twice). The URL stays the source of truth once it catches up.
  const cursor = useRef<string | null>(selected ?? null);
  useEffect(() => { cursor.current = selected ?? null; }, [selected]);
  const cursorId = () => (cursor.current && items.some((m) => m.id === cursor.current) ? cursor.current : selected ?? null);
  const step = (by: 1 | -1) => {
    const at = items.findIndex((m) => m.id === cursorId());
    const next = items[Math.min(Math.max(at + by, 0), items.length - 1)];
    if (!next) return;
    cursor.current = next.id;
    open(next.id);
  };
  useEffect(() => { setFocus("mail", focusId); }, [focusId]);
  const { windowed: mailWindowed, scrollToIndex: mailScrollTo } = mailWin;
  useEffect(() => { if (mailWindowed && selected) mailScrollTo(rowIds.indexOf(selected)); }, [mailWindowed, selected, rowIds, mailScrollTo]);
  useEffect(() => () => setFocus("mail", null), []);
  useCommandHandlers({
    "mail-next": () => { if (!items.length) return false; step(1); },
    "mail-prev": () => { if (!items.length) return false; step(-1); },
    "mail-compose": () => { startCompose(); },
    "mail-search": () => { searchRef.current?.focus(); },
    "mail-archive": () => { if (!canChange) return false; if (hasSel) return runBulk({ action: folder === "archive" ? "inbox" : "archive" }); if (!current) return false; move("archive"); },
    "mail-trash": () => { if (!canChange) return false; if (hasSel) return runBulk({ action: folder === "trash" ? "delete" : "trash" }); if (!current) return false; move("trash"); },
    "mail-star": () => {
      if (!canChange) return false;
      if (hasSel) { const all = sel.ids.every((id) => items.find((m) => m.id === id)?.isStarred); return runBulk({ action: all ? "unstar" : "star" }); }
      if (!current) return false; act.mutate({ ids: [current.id], action: current.isStarred ? "unstar" : "star" });
    },
    "mail-snooze": () => { if (!hasSel || !canChange) return false; setSnoozeOpen(true); },
    "mail-select": () => { const id = cursorId(); if (!id) return false; toggleRow(id, false); },
    "mail-select-all": () => { if (!rowIds.length) return false; setSel(selectAll(rowIds)); },
    // Shift+X, Esc and Cmd/Ctrl+Z are read by the page's own key listener above; these bind the same ids by name.
    "mail-select-range": () => { const id = cursorId(); if (!id) return false; toggleRow(id, true); },
    "mail-select-clear-key": () => { if (!hasSel) return false; setSel(emptySelection()); },
    "mail-undo": () => { if (!runUndo()) return false; },
    "mail-bulk-archive": () => { if (!hasSel) return false; runBulk({ action: folder === "archive" ? "inbox" : "archive" }); },
    "mail-bulk-snooze": () => { if (!hasSel) return false; setSnoozeOpen(true); },
    "mail-bulk-read": () => { if (!hasSel) return false; runBulk({ action: "read" }); },
    "mail-bulk-unread": () => { if (!hasSel) return false; runBulk({ action: "unread" }); },
    "mail-bulk-trash": () => { if (!hasSel) return false; runBulk({ action: folder === "trash" ? "delete" : "trash" }); },
    "mail-bulk-clear": () => { if (!hasSel) return false; setSel(emptySelection()); },
    "mail-read": () => {
      if (!canChange) return false;
      if (hasSel) { const anyUnread = sel.ids.some((id) => items.find((m) => m.id === id)?.isRead === false); return runBulk({ action: anyUnread ? "read" : "unread" }); }
      if (!current) return false;
      act.mutate({ ids: [current.id], action: current.isRead ? "unread" : "read" });
      toast.success(current.isRead ? "Marked unread" : "Marked read");
    },
    "mail-close": () => { if (hasSel) { setSel(emptySelection()); return; } if (!selected) return false; open(null); },
  }, !compose);

  // R31, R79 (MB-273): ] and [ move between Inbox splits while focus is on the page or the message list.
  // Tab is never taken: it always moves keyboard focus, so the page can be used without a mouse.
  const setSplit = useCallback((id: string) => setParam({ split: id === defaultTab ? null : id, m: null }), [setParam, defaultTab]);
  useEffect(() => {
    if (!splitsOn || !splitTabs.length) return;
    const on = (e: KeyboardEvent) => {
      if ((e.key !== "]" && e.key !== "[") || compose || editSplits || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      const listFocus = t === document.body || !!t.closest?.("[data-mail-list]");
      if (!listFocus) return;
      e.preventDefault();
      setSplit(stepSplit(splitTabs, split, e.key === "[" ? -1 : 1));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [splitsOn, splitTabs, split, compose, editSplits, setSplit]);

  // R31 (C): the mail actions the command registry calls by name (src/web/lib/mail-actions.ts).
  // Handlers read the newest state through a ref, so they are registered once.
  const latest = useRef({ items, idx, current, split, splitTabs, move, act, open, startCompose, setSplit, canChange });
  latest.current = { items, idx, current, split, splitTabs, move, act, open, startCompose, setSplit, canChange };
  useEffect(() => registerMailActions({
    archive: () => { const l = latest.current; if (l.current) l.move("archive"); },
    trash: () => { const l = latest.current; if (l.current) l.move("trash"); },
    star: () => { const l = latest.current; if (l.current && l.canChange) l.act.mutate({ ids: [l.current.id], action: l.current.isStarred ? "unstar" : "star" }); },
    markUnread: () => { const l = latest.current; if (l.current && l.canChange) { l.act.mutate({ ids: [l.current.id], action: "unread" }); l.open(null); } },
    next: () => { const l = latest.current; if (l.items.length) l.open(l.items[Math.min(l.idx + 1, l.items.length - 1)].id); },
    prev: () => { const l = latest.current; if (l.items.length) l.open(l.items[Math.max(l.idx - 1, 0)].id); },
    compose: () => latest.current.startCompose(),
    search: () => searchRef.current?.focus(),
    close: () => latest.current.open(null),
    nextSplit: () => { const l = latest.current; if (l.splitTabs.length) l.setSplit(stepSplit(l.splitTabs, l.split, 1)); },
    prevSplit: () => { const l = latest.current; if (l.splitTabs.length) l.setSplit(stepSplit(l.splitTabs, l.split, -1)); },
  }), []);

  // PRIV1b (WC1): with a ?mailbox= the list does not wait for the overview; the folders fill in when it answers.
  const early = !overview.data && !!mailboxId;
  if (overview.isPending && !early) return <div className="flex h-full"><div className="hidden w-60 border-r border-line p-4 md:block"><Skeleton className="mb-4 h-9" />{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="mb-2 h-7" />)}</div><div className="flex-1 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="mb-3 h-14" />)}</div></div>;
  // F12 (MB-295): a failed read is not "no mailboxes"; say it failed and offer Retry. Loaded mailboxes stay on screen.
  if (overview.isError && overview.data === undefined && !early) {
    return <div className="grid h-full place-items-center p-6"><LoadError onRetry={() => overview.refetch()} /></div>;
  }
  if (!mailboxes.length && !early) {
    return (
      <div className="grid h-full place-items-center p-6">
        {/* R74 (MB-212): no domain needed for a first email: the free address is offered right here when it is on. */}
        <NoMailboxes />
      </div>
    );
  }
  const mb = mailboxes.find((m) => m.id === mailboxId) ?? busiest ?? ({ id: mailboxId, address: "", displayName: "", usedBytes: 0, quotaMb: 0, folders: {} } as MailboxOverview);

  // R79: the list and the reader, placed by the person's reading pane choice below.
  const listSection = (
      <section data-mail-pane={paned ? mailPane : undefined} className={cn("flex min-w-0 flex-col", paned ? "h-full" : mailPane === "off" && wideMail ? (selected ? "hidden" : "flex flex-1") : cn("border-r border-line md:w-[340px] lg:w-[380px] xl:w-[420px]", selected ? "hidden md:flex" : "flex flex-1 md:flex-none"))} aria-label={tr("mail.messages")}>
        <div className="flex items-center gap-2 border-b border-line p-3">
          <Select aria-label={tr("mail.folder")} value={q ? "search" : label ? `label:${label}` : folder} onChange={(e) => {
            const v = e.target.value;
            if (v === "rules") { navigate(`/app/mail/rules?mailbox=${mailboxId}`); return; }
            if (v.startsWith("label:")) { setParam({ label: v.slice(6), folder: null, m: null, q: null, split: null }); return; }
            setParam({ folder: v === "inbox" ? null : v, m: null, q: null, label: null });
          }} className="h-9 w-auto! max-w-[9.5rem] shrink-0 text-[13px] font-medium md:hidden">
            {q && <option value="search">{tr("common.search")}</option>}
            {FOLDER_UI.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            {SCHEDULE_VIEWS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            {(labels.data ?? []).map((l) => <option key={l.label} value={`label:${l.label}`}>{l.label}</option>)}
            <option value="rules">{tr("mail.rules")}</option>
          </Select>
          <form className="relative flex-1" role="search" onSubmit={(e) => { e.preventDefault(); setParam({ q: search.trim() || null, m: null }); }}>
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr("mail.search_mail")} aria-label={tr("mail.search_mail")}
              className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-8 text-[13px] outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-subtle focus:border-brand/60 focus:ring-4 focus:ring-brand/10 max-sm:h-11 max-sm:text-base" />
            {q && <button type="button" onClick={() => setParam({ q: null })} className="absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-subtle hover:bg-hover hover:text-fg max-sm:h-9 max-sm:w-9" aria-label={tr("mail.clear_search")}><IconClose className="h-3.5 w-3.5" /></button>}
          </form>
          <button className="inline-flex shrink-0 items-center justify-center rounded-lg bg-brand p-2 text-brand-fg transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] hover:bg-brand-press md:hidden max-sm:h-11 max-sm:w-11" onClick={() => startCompose()} aria-label={tr("mail.compose")}><IconCompose className="h-4 w-4" /></button>
        </div>
        <MailSyncBanner />
        {splitsOn && splitTabs.length > 0 && <SplitTabs tabs={splitTabs} active={split} onChange={setSplit} onEdit={() => setEditSplits(true)} onDropMessage={(id, tab) => teach.mutate({ messageId: id, tab })} />}
        {splitsOn && splits.data && splitTabs.length === 0 && (
          <div className="flex items-center justify-end border-b border-line px-2 py-1">
            <button type="button" onClick={() => setEditSplits(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] text-subtle hover:bg-hover hover:text-fg max-sm:h-11">{tr("mail.turn_on_tabs")}</button>
          </div>
        )}
        <div className="flex items-center justify-between px-4 py-2 text-xs text-subtle">
          {label ? <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="label-view"><IconTag className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="truncate">{label}</span>
            <button type="button" onClick={() => setParam({ label: null, m: null })} className="grid h-6 w-6 place-items-center rounded hover:bg-hover hover:text-fg max-sm:h-9 max-sm:w-9" aria-label={tr("mail.clear_label")}><IconClose className="h-3 w-3" /></button></span>
          : <span>{q ? `Results for “${q}”` : FOLDER_UI.find((f) => f.id === folder)?.label ?? SCHEDULE_VIEWS.find((f) => f.id === folder)?.label ?? folder.slice(2)}</span>}
          {canChange && folder === "trash" && !q && items.length > 0 && <button className="text-muted hover:text-bad" onClick={() => act.mutate({ ids: items.map((i) => i.id), action: "delete" })}>{tr("mail.empty_trash")}</button>}
          {canChange && archiveOlderOffered({ folder, q, loaded: items.length, inboxTotal: mb.folders.inbox?.total ?? 0 }) && <button type="button" data-testid="archive-older" onClick={() => setOlderOpen(true)} aria-haspopup="dialog"
            className="-my-1.5 -mr-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11">
            <IconArchive className="h-3.5 w-3.5" />{tr("mail.archive_older")}</button>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" data-mail-list>
          {hasSel && canChange && !(isScheduleView(folder) && !q) && <BulkBar count={everything ? rowIds.length - everything.length : sel.ids.length} total={items.length} folder={q ? "" : folder} connectionId={mb.connectionId}
            snoozeOpen={snoozeOpen} setSnoozeOpen={setSnoozeOpen} onAct={(c, label) => runBulk(c, label)} onSelectAll={() => setSel(selectAll(rowIds))} onClear={() => setSel(emptySelection())}
            more={list.hasNextPage && jobScope() ? everythingWords(everything, folderTotal(), q ? "" : FOLDER_UI.find((f) => f.id === folder)?.label ?? "", () => { setSel(selectAll(rowIds)); setEverything([]); }) : undefined} />}
          {isScheduleView(folder) && !q ? <ScheduleListView view={folder} mailboxId={mailboxId} onOpen={open} onEdit={(it) => void editScheduled(it)} /> : <>
          <ReturnedStrip items={returnedItems} onOpen={openReturned} />
          {list.isPending ? Array.from({ length: 7 }).map((_, i) => <div key={i} className="space-y-2 border-b border-line px-4 py-3.5"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-3.5 w-56" /><Skeleton className="h-3 w-full" /></div>)
            : items.length === 0 ? (
              <EmptyState icon={q ? <IconSearch /> : label ? <IconTag /> : <IconInbox />} art={q ? <NoSearchResultsArt /> : folder === "inbox" && !label ? <InboxZeroArt /> : <MailFolderArt />} title={q ? "No matches" : folder === "inbox" || label ? label ? "Nothing with this label" : emptyInboxTitle({ split, defaultSplit: defaultTab, tabs: splitsOn ? splitTabs.length : 0, inboxTotal: mb.folders.inbox?.total ?? 0 }) : folderEmpty(folder).title}
                body={q ? "Try a different word, a sender's address, or check the spelling." : label ? "Add this label to a thread from its toolbar, or let a mail rule add it." : folder === "inbox" ? `New mail to ${mb.address} lands here.` : folderEmpty(folder).body}
                action={!q && folder !== "inbox" ? <ButtonLink to="/app/mail" variant="secondary">{tr("mail.back_to_inbox")}</ButtonLink> : undefined} />
            ) : (
              <ul ref={mailListRef}>
                {mailWin.padTop > 0 && <li aria-hidden="true" style={{ height: mailWin.padTop }} />}
                {items.slice(mailWin.start, mailWin.end).map((m, i) => <ListRow key={m.id} row={mailWin.start + i} total={items.length} m={m} active={m.id === selected} folder={folder}
                  checked={everything ? !everything.includes(m.id) : sel.ids.includes(m.id)} selecting={hasSel} onCheck={(shift) => toggleRow(m.id, shift)}
                  onOpen={() => (m.folder === "drafts" ? openDraft(m.id) : open(m.id))}
                  onStar={canChange ? () => act.mutate({ ids: [m.id], action: m.isStarred ? "unstar" : "star" }) : undefined}
                  onSwipe={hasSel || !canChange ? undefined : (action) => swipeAct(m.id, action)} draggable={splitsOn && splitTabs.length > 1} />)}
                {mailWin.padBottom > 0 && <li aria-hidden="true" style={{ height: mailWin.padBottom }} />}
              </ul>
            )}
          {list.hasNextPage && <div className="p-3"><Button variant="ghost" className="w-full" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>{tr("mail.load_more")}</Button></div>}
          </>}
        </div>
      </section>
  );
  const readerSection = (
      <section className={cn("min-w-0", paned ? "flex h-full" : mailPane === "off" && wideMail ? (selected ? "flex flex-1" : "hidden") : cn("flex-1", selected ? "flex" : "hidden md:flex"))} aria-label={tr("mail.message")}>
        {current || selected ? (
          <Reader id={selected!} mailboxes={mailboxes} onBack={() => open(null)} onMove={move}
            onMoveTo={(m, to) => { act.mutate({ ids: [m.id], action: "move", to }); open(null); }}
            onCompose={startCompose} onStar={(m) => act.mutate({ ids: [m.id], action: m.isStarred ? "unstar" : "star" })} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div><div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl border border-line bg-elevated text-subtle"><IconInbox className="h-5 w-5" /></div>
              <p className="text-sm text-muted">{tr("mail.select_a_message_to_read")}</p>
              <p className="mt-2 text-xs text-subtle">{tr("mail.press_j_to_open", { key: "\u0000" }).split("\u0000").flatMap((part, i) => (i ? [<Kbd key={i}>j</Kbd>, part] : [part]))}</p></div>
          </div>
        )}
      </section>
  );

  return (
    <div className="flex h-full">
      {/* Folders */}
      <h1 className="sr-only">{tr("common.mail")}</h1>
      <aside aria-label={tr("mail.mailboxes_and_folders")} className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface/50 md:flex xl:w-60">
        <div className="p-3">
          <Button className="w-full" onClick={() => startCompose()}><IconCompose className="h-4 w-4" />{tr("mail.compose")}</Button>
          <button onClick={() => setInvoiceOpen(true)} className="mt-2 w-full rounded-lg px-2 py-1.5 text-left text-[13px] text-muted hover:bg-hover hover:text-fg">{tr("mail.chase_an_unpaid_invoice")}</button>
        </div>
        <div className="px-3">
          <label htmlFor="mailbox-switch" className="sr-only">{tr("mail.mailbox")}</label>
          <Select bare id="mailbox-switch" value={mb.id} onChange={(e) => setParam({ mailbox: e.target.value, m: null, q: null })} className="h-9 w-full truncate rounded-lg border border-line bg-surface px-2 text-[13px] outline-none focus:border-brand/60"
            phoneClassName={`${PHONE_PICK} h-11 w-full px-3`}>
            {(mailboxes.length ? mailboxes : [mb]).map((m) => <option key={m.id} value={m.id}>{m.address || tr("mail.mailbox")}{m.kind === "agent" ? " (agent)" : ""}{m.folders.inbox?.unread ? ` (${m.folders.inbox.unread})` : ""}</option>)}
          </Select>
        </div>
        <nav className="mt-3 flex-1 space-y-0.5 overflow-y-auto px-3" aria-label={tr("mail.folders")}>
          {FOLDER_UI.map(({ id, label, icon: Icon }) => {
            const unread = id === "inbox" || id === "spam" ? mb.folders[id as Folder]?.unread : undefined;
            const count = id === "drafts" ? mb.folders.drafts?.total : unread;
            return (
              <button key={id} onClick={() => setParam({ folder: id === "inbox" ? null : id, m: null, q: null, label: null })} aria-current={!q && !label && folder === id ? "page" : undefined}
                className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors", !q && folder === id ? "bg-fill font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
                <Icon className="h-4 w-4" />{label}
                {!!count && <span className={cn("ml-auto text-[11px] tabular-nums", id === "inbox" ? "rounded bg-brand px-1.5 font-semibold text-brand-fg" : "text-subtle")}>{count}</span>}
              </button>
            );
          })}
          {SCHEDULE_VIEWS.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setParam({ folder: id, m: null, q: null, label: null })} aria-current={!q && !label && folder === id ? "page" : undefined}
              className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors", !q && folder === id ? "bg-fill font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
              <Icon className="h-4 w-4" />{label}
            </button>
          ))}
          {mb.connectionId && <ProviderFolderNav connectionId={mb.connectionId} current={q ? "" : folder} onPick={(key) => setParam({ folder: key, m: null, q: null })} />}
          {/* R85: labels and mail rules. */}
          {(labels.data?.length ?? 0) > 0 && (
            <div className="pt-3" data-testid="label-nav">
              <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">{tr("mail.labels")}</div>
              {labels.data!.map((l) => (
                <button key={l.label} onClick={() => setParam({ label: l.label, folder: null, m: null, q: null, split: null })} aria-current={label === l.label ? "page" : undefined}
                  className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors", label === l.label ? "bg-fill font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
                  <IconTag className="h-4 w-4" /><span className="min-w-0 flex-1 truncate text-left">{l.label}</span><span className="text-[11px] tabular-nums text-subtle">{l.threads}</span>
                </button>
              ))}
            </div>
          )}
          <div className="pt-3">
            <Link to={`/app/mail/rules?mailbox=${mailboxId}`} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] text-muted transition-colors hover:bg-hover hover:text-fg" data-testid="mail-rules-link"><IconWorkflow className="h-4 w-4" />{tr("mail.rules")}</Link>
          </div>
        </nav>
        <div className="border-t border-line p-3 text-[11px] text-subtle">
          {mb.quotaMb > 0 && <>
          <div className="mb-1 flex justify-between"><span>{tr("mail.storage")}</span><span>{formatBytes(mb.usedBytes)} of {formatBytes(mb.quotaMb * 1024 * 1024)}</span></div>
          <div className="h-1 overflow-hidden rounded-full bg-fill"><div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(2, Math.min(100, (mb.usedBytes / (mb.quotaMb * 1048576)) * 100))}%` }} /></div></>}
          <div className="mt-3 hidden gap-x-3 gap-y-1 xl:flex xl:flex-wrap"><span><Kbd>c</Kbd> {tr("mail.key_compose")}</span><span><Kbd>j</Kbd>/<Kbd>k</Kbd> {tr("mail.key_move")}</span><span><Kbd>e</Kbd> {tr("mail.key_archive")}</span><span><Kbd>t</Kbd> {tr("mail.key_task")}</span><span><Kbd>/</Kbd> {tr("mail.key_search")}</span></div>
        </div>
      </aside>

      {/* R79: the reading pane sits right, below, or off (the View menu), with a draggable divider. */}
      {paned ? (
        <Group key={`mail-${mailPane}-${layoutGen}`} id={`mail-${mailPane}`} orientation={mailPane === "bottom" ? "vertical" : "horizontal"} className="min-w-0 flex-1"
          defaultLayout={mailLayout.defaultLayout} onLayoutChanged={mailLayout.onLayoutChanged}>
          <Panel id="mail-list" defaultSize={mailPane === "bottom" ? "45%" : "400px"} minSize={mailPane === "bottom" ? "20%" : "300px"} maxSize={mailPane === "bottom" ? "80%" : "65%"}>{listSection}</Panel>
          <Separator className="pane-separator" aria-label={tr("mail.resize_reading_pane")} />
          <Panel id="mail-reader" minSize={mailPane === "bottom" ? "20%" : "360px"}>{readerSection}</Panel>
        </Group>
      ) : <>{listSection}{readerSection}</>}

      <ArchiveOlderSheet open={olderOpen} onClose={() => setOlderOpen(false)} mailboxId={mailboxId} asOf={olderOpen ? listAsOf() || new Date().toISOString() : ""} onRun={runArchiveOlder} everyTab={splitsOn && splitTabs.length > 0} />

      <InvoiceReminderDialog open={invoiceOpen} onClose={() => setInvoiceOpen(false)} onCompose={startCompose} />
      <Dialog open={!!confirmJob} onClose={() => setConfirmJob(null)} title={confirmJob?.title ?? ""} description={confirmJob?.description}
        footer={<><Button variant="secondary" onClick={() => setConfirmJob(null)}>{tr("common.cancel")}</Button><Button autoFocus data-testid="bulk-job-confirm" onClick={() => confirmRef.current()}>{confirmJob?.button ?? "Go"}</Button></>}>
        <span className="sr-only">{tr("mail.enter_confirms_escape_cancels")}</span>
      </Dialog>
      <Dialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title={confirmDelete ? `Delete ${confirmDelete.ids.length === 1 ? "1 conversation" : `${confirmDelete.ids.length} conversations`} forever?` : ""}
        description={tr("mail.they_leave_trash_for_good_this_can_t_be_undone")}
        footer={<><Button variant="secondary" onClick={() => setConfirmDelete(null)}>{tr("common.cancel")}</Button><Button variant="danger" data-testid="bulk-delete-confirm" onClick={() => { const c = confirmDelete; setConfirmDelete(null); if (c) runBulk({ action: "delete" }, undefined, true); }}>{tr("mail.delete_forever")}</Button></>}>
        <span className="sr-only">{tr("mail.confirm")}</span>
      </Dialog>
      {splitsOn && <EditSplitsDialog open={editSplits} onClose={() => setEditSplits(false)} mailboxId={mailboxId} splits={splits.data?.splits ?? []} tabs={splitTabs} style={splits.data?.style} />}
      {compose && <Compose key={JSON.stringify(compose).length + compose.subject} initial={compose} mailboxes={mailboxes} onClose={closeCompose} />}
    </div>
  );

  async function openDraft(id: string) {
    const { message } = await api.get<{ message: Message }>(`/mail/messages/${id}`);
    setCompose({ mailboxId: message.mailboxId, to: message.to.map((a) => a.address).join(", "), cc: message.cc.map((a) => a.address).join(", "), subject: message.subject, text: message.text, draftId: message.id, threadId: message.threadId });
  }
}

/** DES1: a stable hue per sender for the initials circle. */
function avatarHue(key: string) { let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360; return h; }

function ListRow({ m, row, total, active, folder, onOpen, onStar, checked, selecting, onCheck, onSwipe, draggable }: { m: MessageListItem & { labels?: string[] }; row?: number; total?: number; active: boolean; folder: View; onOpen: () => void; onStar?: () => void; checked: boolean; selecting: boolean; onCheck: (shift: boolean) => void; onSwipe?: (action: "archive" | "snooze") => void; draggable?: boolean }) {
  const who = folder === "sent" || folder === "drafts" ? `To: ${m.to.map((t) => t.name || t.address).join(", ") || "(no recipients)"}` : m.from.name || m.from.address;
  return (
    <li className={cn("group relative border-b border-line transition-colors duration-150 ease-out", checked ? "bg-brand-soft/80" : active ? "bg-brand-soft/60" : "hover:bg-hover")} data-selected={checked || undefined} data-testid="mail-row" data-win-row={row} aria-setsize={total} aria-posinset={row === undefined ? undefined : row + 1}>
      <SwipeRow disabled={!onSwipe || selecting} testId="mail-swipe"
        left={onSwipe && folder !== "archive" ? { label: "Archive", icon: IconArchive, tone: "blue", onCommit: () => onSwipe("archive") } : undefined}
        right={onSwipe && folder !== "snoozed" && folder !== "sent" && folder !== "drafts" ? { label: "Snooze", icon: IconSnooze, tone: "orange", onCommit: () => onSwipe("snooze") } : undefined}>
      <RowCheck checked={checked} visible={selecting} label={`Select ${m.subject || "(no subject)"}`} onToggle={onCheck} />
      <button onClick={(e) => { if (e.shiftKey || e.metaKey || e.ctrlKey) { e.preventDefault(); onCheck(e.shiftKey); return; } onOpen(); }} className="block w-full py-3 pl-9 pr-10 text-left" aria-current={active || undefined}
        draggable={draggable || undefined} onDragStart={draggable ? (e) => { e.dataTransfer.setData(MAIL_DRAG_TYPE, m.id); e.dataTransfer.effectAllowed = "move"; } : undefined}>
        {/* DES1: a sender initials circle, shown only by the design pass (hidden while DESIGN_DES1 is off). */}
        <span className="ds-avatar" aria-hidden style={{ ["--ds-av-h" as string]: String(avatarHue(m.from.address || who)) }}>{initials(m.from.name || m.from.address || "?")}</span>
        <div className="flex items-baseline gap-2">
          {!m.isRead && <span className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full bg-brand" aria-label={tr("mail.unread")} />}
          <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", m.isRead ? "text-fg/75" : "font-semibold text-fg")}>{who}</span>
          <time className="shrink-0 text-[11.5px] text-subtle" dateTime={m.date}>{mailDate(m.date)}</time>
        </div>
        <div className={cn("mt-0.5 flex items-center gap-1.5 truncate text-[13px]", m.isRead ? "text-muted" : "text-fg/90")}>
          {m.sentByAgentId && <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-brand/40 px-1 text-[11px] text-brand-hover"><IconAgent className="h-3 w-3" aria-hidden />{tr("mail.agent")}</span>}
          {m.hasAttachments && <IconAttachment className="h-3 w-3 shrink-0 text-subtle" />}<span className="truncate">{m.subject || "(no subject)"}</span>
          <LabelChips labels={m.labels?.slice(0, 2)} className="shrink-0 flex-nowrap" />
        </div>
        <div className="mt-0.5 truncate text-[12.5px] text-subtle">{m.snippet || "\u00a0"}</div>
        {folder === "sent" && <ReadStatusLine status={(m as { readStatus?: ReadStatus | null }).readStatus} className="mt-1" />}
      </button>
      {onStar && <button onClick={onStar} data-testid="mail-star" className={cn("absolute right-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-lg transition-opacity", m.isStarred ? "text-warn opacity-100" : "text-subtle opacity-0 hover:text-fg focus:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 max-sm:opacity-100")} aria-label={m.isStarred ? "Unstar" : "Star"} aria-pressed={m.isStarred}>
        <IconStar filled={m.isStarred} className="h-4 w-4" />
      </button>}
      </SwipeRow>
    </li>
  );
}

function Reader({ id, mailboxes, onBack, onMove, onMoveTo, onCompose, onStar }: {
  id: string; mailboxes: MailboxOverview[]; onBack: () => void; onMove: (a: string) => void; onMoveTo: (m: Message, to: string) => void; onCompose: (d: Partial<ComposeDraft>) => void; onStar: (m: Message) => void;
}) {
  // R31: R, A, F and H on the open message (keys from the command registry).
  const keys = useRef<{ reply?: (all: boolean) => void; forward?: () => void }>({});
  useCommandHandlers({
    "mail-reply": () => { if (!keys.current.reply) return false; keys.current.reply(false); },
    "mail-reply-all": () => { if (!keys.current.reply) return false; keys.current.reply(true); },
    "mail-forward": () => { if (!keys.current.forward) return false; keys.current.forward(); },
    "mail-snooze": () => { const b = document.querySelector<HTMLElement>("[data-testid=snooze-menu]"); if (!b) return false; b.click(); },
  });
  const qc = useQueryClient();
  // R31 (C): reply, reply all and forward by name for the command registry, while a message is open.
  const replyRef = useRef<{ reply: (all: boolean) => void; forward: () => void } | null>(null);
  useEffect(() => registerMailActions({
    reply: () => replyRef.current?.reply(false),
    replyAll: () => replyRef.current?.reply(true),
    forward: () => replyRef.current?.forward(),
  }), []);
  const { data, isPending, error } = useQuery({
    queryKey: ["mail", "message", id],
    queryFn: () => api.get<{ message: Message; thread: Message[]; labels?: string[] }>(`/mail/messages/${id}`),
  });
  // R85: Inbox tabs for "Move to tab" (the same cached query as the list's tabs) and label edits.
  const [readerParams] = useSearchParams();
  const tabsFor = useSplits(data?.message.mailboxId ?? "", !!data && data.message.folder === "inbox");
  const labelEdit = useLabelEdit();
  useEffect(() => { if (data) qc.invalidateQueries({ queryKey: qk.overview }); }, [data, qc]);
  // R67 (MB-244): a reply that was open here when the page reloaded opens again, with its saved draft.
  const resumed = useRef<string | null>(null);
  useEffect(() => {
    if (!data || data.message.folder === "drafts") return;
    const threadId = data.message.threadId;
    const draftId = openReplyDraft(threadId);
    if (!draftId || resumed.current === draftId) return;
    resumed.current = draftId;
    const target = data.thread[data.thread.length - 1] ?? data.message;
    api.get<{ message: Message }>(`/mail/messages/${draftId}`).then(({ message: dm }) => {
      if (dm.folder !== "drafts" || dm.threadId !== threadId) { forgetOpenReply(threadId); return; }
      onCompose({ mailboxId: dm.mailboxId, to: dm.to.map((a) => a.address).join(", "), cc: dm.cc.map((a) => a.address).join(", ") || undefined, subject: dm.subject, text: dm.text, draftId: dm.id, threadId, inReplyToId: target.id, resumed: true });
    }, () => forgetOpenReply(threadId));
  }, [data, onCompose]);
  if (error) return <div className="grid flex-1 place-items-center text-sm text-muted">{tr("mail.this_message_is_no_longer_available")}</div>;
  if (isPending || !data) return <div className="flex-1 space-y-4 p-6"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-4 w-1/3" /><Skeleton className="h-48 w-full" /></div>;
  const { message: m, thread } = data;
  const last = thread[thread.length - 1] ?? m;
  const own = new Set(mailboxes.map((b) => b.address));
  // PRIV1b (P66): a read share gets no reply and no changes here; a reply share gets both (new mail is the composer's call).
  const box = mailboxes.find((b) => b.id === m.mailboxId);
  const change = canChangeMail(box);
  const replyOk = canReplyIn(box);

  const reply = (all: boolean, draft = "") => {
    if (!replyOk) return;
    const target = last;
    const to = own.has(target.from.address) ? target.to.map((t) => t.address) : [target.replyTo || target.from.address];
    const cc = all ? [...target.to, ...target.cc].map((a) => a.address).filter((a) => !own.has(a) && !to.includes(a)) : [];
    onCompose({
      mailboxId: target.mailboxId, to: to.join(", "), cc: cc.join(", "), inReplyToId: target.id, threadId: target.threadId,
      subject: /^re:/i.test(target.subject) ? target.subject : `Re: ${target.subject}`,
      text: `${draft}\n\nOn ${fullDate(target.date)}, ${target.from.name || target.from.address} wrote:\n${target.text.split("\n").map((l) => `> ${l}`).join("\n")}`,
    });
  };
  const forward = () => onCompose({
    mailboxId: last.mailboxId, to: "", forwardOfId: last.id, subject: /^fwd?:/i.test(last.subject) ? last.subject : `Fwd: ${last.subject}`,
    text: `\n\n---------- Forwarded message ----------\nFrom: ${last.from.name ? `${last.from.name} <${last.from.address}>` : last.from.address}\nDate: ${fullDate(last.date)}\nSubject: ${last.subject}\nTo: ${last.to.map((t) => t.address).join(", ")}\n\n${last.text}`,
  });

  keys.current = { reply: replyOk ? reply : undefined, forward };
  replyRef.current = { reply: (all) => reply(all), forward };
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div data-testid="thread-toolbar" className="flex h-[57px] shrink-0 items-center gap-1 border-b border-line px-3 max-sm:h-14 max-sm:justify-between max-sm:gap-0 max-sm:px-1">
        <button onClick={onBack} className="-ml-1 grid place-items-center rounded-md p-2 text-brand-hover transition-colors duration-150 hover:bg-hover md:hidden max-sm:ml-0 max-sm:mr-auto max-sm:h-11 max-sm:w-11 max-sm:rounded-full" aria-label={tr("mail.back_to_list")}><IconArrowLeft className="h-[18px] w-[18px]" /></button>
        {change && m.folder !== "sent" && m.folder !== "drafts" && <>
          <SnoozeMenu messageId={m.id} onDone={onBack} />
          <IconBtn label={m.folder === "archive" ? "Move to inbox" : "Archive (e)"} onClick={() => onMove(m.folder === "archive" ? "inbox" : "archive")}><IconArchive /></IconBtn>
          <IconBtn label={m.folder === "spam" ? "Not spam" : "Report spam"} onClick={() => onMove(m.folder === "spam" ? "inbox" : "spam")}><IconBlock /></IconBtn>
        </>}
        {change && <IconBtn label={m.folder === "trash" ? "Delete forever" : "Delete (#)"} onClick={() => onMove(m.folder === "trash" ? "delete" : "trash")}><IconTrash /></IconBtn>}
        {change && m.remoteBox && m.folder !== "sent" && m.folder !== "drafts" && <MoveTo message={m} mailboxes={mailboxes} onMove={onMove} onMoveTo={onMoveTo} />}
        {change && <IconBtn label={m.isStarred ? "Unstar (s)" : "Star (s)"} onClick={() => onStar(m)} active={m.isStarred}><IconStar filled={m.isStarred} /></IconBtn>}
        {change && m.folder === "inbox" && (tabsFor.data?.tabs.length ?? 0) > 1 && <MoveToTabMenu messageId={m.id} tabs={tabsFor.data!.tabs} current={readerParams.get("split") ?? tabsFor.data!.defaultTab} />}
        {/* R48 mobile: on a phone Reply and Forward live in the thumb bar at the foot (below), so this row never crowds. */}
        <div className="ml-auto flex gap-1 max-sm:hidden">
          {replyOk && <IconBtn label={tr("common.reply")} onClick={() => reply(false)}><IconReply /></IconBtn>}
          <IconBtn label={tr("common.forward")} onClick={forward}><IconForward /></IconBtn>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8">
          <h1 className="text-xl font-semibold leading-snug tracking-tight">{m.subject || "(no subject)"}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <MakeTask messageId={last.id} threadId={last.threadId} shortcut />
            {m.folder !== "drafts" && <span className="inline-flex items-center gap-1" data-testid="reader-labels">
              <LabelChips labels={data.labels} onRemove={change ? (l) => labelEdit.remove.mutate({ threadId: m.threadId, label: l }) : undefined} />
              {change && <LabelMenu threadId={m.threadId} labels={data.labels ?? []} />}
            </span>}
          </div>
          {m.folder !== "drafts" && <ThreadPresenceLine threadId={m.threadId} mailboxId={m.mailboxId} />}
          <Assistant key={last.id} messageId={last.id} onDraft={(text) => reply(false, text)} />
          <div className="mt-6 space-y-4">
            {thread.map((t, i) => <ThreadMessage key={t.id} m={t} defaultOpen={i === thread.length - 1 || !t.isRead} />)}
            <BatchTools attachments={thread.flatMap((t) => t.attachments)} /> {/* Tools P2: batch */}
          </div>
          <div className="mt-6 flex gap-2 max-sm:hidden">
            {replyOk && <Button variant="secondary" onClick={() => reply(false)}><IconReply className="h-4 w-4" />{tr("common.reply")}</Button>}
            {replyOk && (last.to.length + last.cc.length > 1) && <Button variant="secondary" onClick={() => reply(true)}>{tr("mail.reply_all")}</Button>}
            <Button variant="ghost" onClick={forward}><IconForward className="h-4 w-4" />{tr("common.forward")}</Button>
          </div>
        </div>
      </div>
      {/* R48 mobile: the reply bar sits under the thumb on a phone, like a native mail app; 44 px targets, one row at 360. */}
      <div data-testid="thread-reply-bar" className="hidden shrink-0 items-stretch gap-2 border-t border-line bg-elevated/95 px-3 py-2 backdrop-blur max-sm:flex">
        {replyOk && <button type="button" onClick={() => reply(false)} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-brand text-[15px] font-medium text-white transition-colors duration-150 active:bg-[#0062c4]"><IconReply className="h-[18px] w-[18px]" aria-hidden />{tr("common.reply")}</button>}
        {replyOk && (last.to.length + last.cc.length > 1) && <button type="button" onClick={() => reply(true)} className="flex h-11 items-center justify-center rounded-full border border-line-strong px-4 text-[15px] font-medium text-fg transition-colors duration-150 active:bg-hover">{tr("mail.reply_all")}</button>}
        <button type="button" onClick={forward} aria-label={tr("common.forward")} className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line-strong text-fg transition-colors duration-150 active:bg-hover"><IconForward className="h-[18px] w-[18px]" aria-hidden /></button>
        {/* R50 (MB-238): make a task, or open the thread's task, without scrolling back up. */}
        <MakeTaskBarButton messageId={last.id} threadId={last.threadId} />
      </div>
    </div>
  );
}

const TRIAGE_LABEL: Record<string, string> = { needs_reply: "Needs a reply", invoice: "Invoice", receipt: "Receipt", update: "Update", newsletter: "Newsletter", suspicious: "Looks suspicious" };

/** QUAL1: an AI answer may say built-in AI wrote it because the workspace's own key was refused. */
type AiFallbackNote = { fallback?: { reason: string; message: string } };

/**
 * Round 2 (PR 20 leftover): a good answer on the workspace's own key (no stand-in) while the key problem banner shows
 * means the key works again, so the AI status is read again and the banner clears. Exported for tests.
 */
export const keyWorksAgain = (problemShown: boolean, answer: AiFallbackNote | undefined) => problemShown && !!answer && !answer.fallback;

/** Summaries, triage and drafted replies, on the workspace's own AI key (bring your own AI). */
export function Assistant({ messageId, onDraft }: { messageId: string; onDraft: (text: string) => void }) { // exported for tests (QUAL1)
  const status = useAiStatus();
  const qc = useQueryClient();
  // QUAL1 (audit rows 12, 14): a key refusal changes what Settings shows, so the status is read again after one.
  const onAiError = (e: Error) => { if (e instanceof ApiError && AI_KEY_CODES.has(e.code)) void qc.invalidateQueries({ queryKey: ["ai-status"] }); };
  const onAiAnswer = (r: AiFallbackNote) => { if (keyWorksAgain(!!(status.data?.connected && status.data?.problem), r)) void qc.invalidateQueries({ queryKey: ["ai-status"] }); };
  const summary = useMutation({ mutationFn: () => api.post<{ summary: string; actionItems: string[] } & AiFallbackNote>("/ai/summary", { messageId }), onSuccess: onAiAnswer, onError: onAiError });
  const triage = useMutation({ mutationFn: () => api.post<{ triage: { category: string; priority: string; reason: string } } & AiFallbackNote>("/ai/triage", { messageId }), onSuccess: onAiAnswer, onError: onAiError });
  const draft = useMutation({ mutationFn: () => api.post<{ text: string } & AiFallbackNote>("/ai/draft", { messageId }), onSuccess: (r) => { onAiAnswer(r); onDraft(r.text); }, onError: onAiError });
  // AI2 (MB-330), QUAL1 (row 12): every failure stays on the page in plain words with Retry, not only in a toast.
  const failed = [summary, draft, triage].find((m) => m.isError && m.error);
  const aiFailure = failed?.error ? errorMessage(failed.error) : null;
  const failedCode = failed?.error instanceof ApiError ? failed.error.code : null;
  const fallbackNote = [summary.data, draft.data, triage.data].find((d) => d?.fallback)?.fallback?.message ?? null;
  if (!status.data) return null;
  // AI2 (MB-330): the workspace switch is off, so say so plainly instead of offering buttons that would be refused.
  if (status.data.builtin?.off) {
    return (
      <section aria-label={tr("mail.assistant")} role="status" data-testid="mail-ai-off" className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/60 p-3 text-sm text-muted">
        <IconSparkle className="h-4 w-4 text-subtle" aria-hidden />
        <span>{AI_OFF_MESSAGE}</span>
        <span className="ml-auto flex gap-2">
          <ButtonLink size="sm" variant="ghost" to="/app/settings#ai-trust">{tr("mail.open_ai_settings")}</ButtonLink>
        </span>
      </section>
    );
  }
  // AI2: built-in AI (free, capped daily) runs the assistant when the workspace has no key of its own.
  if (!status.data.connected && !status.data.builtin?.active) {
    return (
      <section aria-label={tr("mail.assistant")} className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/60 p-3 text-sm text-muted max-sm:hidden">
        <IconSparkle className="h-4 w-4 text-brand-hover" aria-hidden />
        <span>{BYO_AI_LINE}</span>
        <span className="ml-auto flex gap-2">
          <ButtonLink size="sm" variant="secondary" to="/agents#mcp">MCP setup</ButtonLink>
          <ButtonLink size="sm" variant="ghost" to="/app/settings#ai">{tr("mail.use_your_own_key")}</ButtonLink>
        </span>
      </section>
    );
  }
  return (
    <section aria-label={tr("mail.assistant")} className="mt-4 rounded-xl border border-line bg-elevated/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconSparkle className="h-4 w-4 text-brand-hover" aria-hidden />
        <Button size="sm" variant="secondary" loading={summary.isPending} onClick={() => summary.mutate()}>{tr("mail.summarise")}</Button>
        <Button size="sm" variant="secondary" loading={draft.isPending} onClick={() => draft.mutate()}>{tr("mail.draft_a_reply")}</Button>
        <Button size="sm" variant="ghost" loading={triage.isPending} onClick={() => triage.mutate()}>{tr("mail.sort_it")}</Button>
        {status.data.connected && !status.data.problem && <span className="ml-auto text-xs text-subtle">On your {status.data.providerName} key</span>}
      </div>
      {/* QUAL1 (audit row 14): a refused key is never shown as working. */}
      {status.data.connected && status.data.problem && (
        <p role="status" data-testid="mail-ai-key-problem" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-fg">
          {status.data.problemMessage}{" "}<Link to={AI_KEY_FIX_PATH} className="font-medium text-brand-hover underline-offset-2 hover:underline">{tr("ai.fix_key")}</Link>
        </p>
      )}
      {triage.data && (
        <p className="mt-3 text-sm"><span className={cn("mr-2 rounded border px-1.5 py-0.5 text-xs", triage.data.triage.category === "suspicious" ? "border-bad/50 text-bad" : "border-line text-muted")}>{TRIAGE_LABEL[triage.data.triage.category] ?? triage.data.triage.category}{triage.data.triage.priority === "high" ? ", urgent" : ""}</span>{triage.data.triage.reason}</p>
      )}
      {summary.data && (
        <div className="mt-3 text-sm">
          <p className="leading-relaxed">{summary.data.summary}</p>
          {summary.data.actionItems.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">{summary.data.actionItems.map((a) => <li key={a}>{a}</li>)}</ul>}
        </div>
      )}
      {fallbackNote && <p className="mt-2 text-xs text-muted" data-testid="mail-ai-fallback">{fallbackNote}</p>}
      {aiFailure && failed && (
        <div role="alert" data-testid="mail-ai-refused" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">
          <span>{aiFailure}</span>
          <span className="flex gap-2">
            {failedCode && AI_KEY_CODES.has(failedCode) && <ButtonLink size="sm" variant="ghost" to={AI_KEY_FIX_PATH}>{tr("ai.fix_key")}</ButtonLink>}
            <Button size="sm" variant="outline" loading={failed.isPending} onClick={() => failed.mutate()} data-testid="mail-ai-retry">{tr("common.retry")}</Button>
          </span>
        </div>
      )}
    </section>
  );
}

function ThreadMessage({ m, defaultOpen }: { m: Message; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const auth = m.authResults;
  const authOk = auth && auth.dmarc === "pass";
  const authBad = auth && (auth.dmarc === "fail" || auth.spf === "fail");
  const translateOn = !!useConfig().data?.translateR116; // R116
  return (
    <article className="rounded-xl border border-line bg-surface">
      <button className="flex w-full items-start gap-3 p-4 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Avatar label={initials(m.from.name || m.from.address)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{m.from.name || m.from.address}</span>
            {m.from.name && <span className="truncate text-xs text-subtle">&lt;{m.from.address}&gt;</span>}
          </div>
          <div className="truncate text-xs text-subtle">
            {open ? <>to {m.to.map((t) => t.name || t.address).join(", ")}{m.cc.length ? `, cc ${m.cc.map((c) => c.address).join(", ")}` : ""}</> : m.snippet}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {authOk && <span title={tr("mail.spf_dkim_and_dmarc_passed")}><IconShieldCheck className="h-4 w-4 text-ok" aria-label={tr("mail.sender_verified")} /></span>}
          {authBad && <span title={tr("mail.sender_authentication_failed")}><IconShieldAlert className="h-4 w-4 text-bad" aria-label={tr("mail.sender_not_verified")} /></span>}
          <time className="text-xs text-subtle" dateTime={m.date}>{fullDate(m.date)}</time>
        </div>
      </button>
      {open && (
        <div className="px-4 pb-5 sm:pl-[60px]">
          {m.folder === "sent" && <div className="mb-3"><ReadStatusLine status={(m as { readStatus?: ReadStatus | null }).readStatus} /></div>}
          {translateOn ? <MailBodyLazy id={m.id} html={m.html} text={m.text} /> : m.html ? <HtmlBody html={m.html} /> : <TextBody text={m.text} />}
          {m.attachments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <span key={a.id} className="flex items-stretch gap-1">
                  <a href={a.available ? `/api/mail/attachments/${a.id}` : undefined} download={a.filename} aria-disabled={!a.available}
                    className={cn("flex items-center gap-2.5 rounded-lg border border-line bg-elevated px-3 py-2 text-xs", a.available ? "hover:border-line-strong" : "cursor-not-allowed opacity-60")}
                    title={a.available ? `Download ${a.filename}` : "Too large to store inline"}>
                    <IconFile className="h-4 w-4 text-subtle" /><span className="max-w-48 truncate font-medium">{a.filename}</span><span className="text-subtle">{formatBytes(a.sizeBytes)}</span>
                  </a>
                  {a.available && <AttachmentTools id={a.id} filename={a.filename} />}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** Move a connected mailbox's message to any synced folder at its provider (round 19). */
function MoveTo({ message: m, mailboxes, onMove, onMoveTo }: { message: Message; mailboxes: MailboxOverview[]; onMove: (a: string) => void; onMoveTo: (m: Message, to: string) => void }) {
  const connectionId = mailboxes.find((b) => b.id === m.mailboxId)?.connectionId;
  const { data } = useProviderFolders(connectionId);
  const targets = moveTargets(data, m.remoteBox);
  if (!connectionId || !targets.length) return null;
  return (
    <label className="relative flex items-center rounded-md p-2 text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11 max-sm:justify-center max-sm:rounded-full" title={tr("mail.move_to_folder")}>
      <IconMove className="h-4 w-4" aria-hidden />
      <Select bare aria-label={tr("mail.move_to_folder")} value="" data-testid="move-to" phoneClassName="absolute inset-0 cursor-pointer opacity-0"
        onChange={(e) => { const to = e.target.value; if (!to) return; if (to.startsWith("f:")) onMoveTo(m, to); else onMove(to); }}
        className="absolute inset-0 cursor-pointer opacity-0">
        <option value="">{tr("mail.move_to")}</option>
        {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </Select>
    </label>
  );
}

function IconBtn({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className={cn("grid place-items-center rounded-md p-2 transition-colors duration-150 ease-out hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-11 max-sm:w-11 max-sm:rounded-full [&_svg]:h-4 [&_svg]:w-4 max-sm:[&_svg]:h-5 max-sm:[&_svg]:w-5", active ? "text-warn" : "text-muted hover:text-fg")}>
      {children}
    </button>
  );
}

/** R33: the words of the "select everything" link in the selection bar, before and after choosing it (short: the bar is narrow). */
function everythingWords(chosen: string[] | null, total: number | null, where: string, onAll: () => void) {
  const left = total !== null ? Math.max(0, total - (chosen?.length ?? 0)) : null;
  const n = (x: number) => x.toLocaleString("en-US");
  return {
    all: !!chosen,
    offer: total !== null ? `Select all ${n(total)}` : where ? `Select all in ${where}` : "Select all matches",
    chosen: left !== null ? `All ${n(left)} selected` : "All selected",
    onAll,
  };
}

/** R74 (MB-212): Mail with no mailbox. When the free address is on and free to take, it is offered first. */
function NoMailboxes() {
  const free = useFreeAddress().data;
  const offer = !!free?.enabled && !!free.available && !free.addresses[0];
  return (
    <div className="w-full max-w-lg space-y-4" data-testid="mail-no-mailboxes">
      {offer && <FreeAddressCard />}
      <EmptyState icon={<IconInbox />} title={tr("mail.no_mailboxes_yet")}
        body={offer ? tr("mail.take_the_free_address") : tr("mail.create_a_mailbox_on_one_of_your_domains")}
        action={<ButtonLink to="/app/mailboxes" variant={offer ? "secondary" : "primary"}>{tr("mail.create_a_mailbox")}</ButtonLink>} />
    </div>
  );
}
