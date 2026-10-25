/**
 * Round 24: live co-editing shared by the doc page and the meeting notes. Both open the
 * same room for a doc (doc-collab.ts), bind Tiptap to it, and let only the leader save the
 * doc row through REST. When the room does not answer, the editor falls back to the single
 * person mode that saves through REST with a version check.
 */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { connectCollab, FIELD, hashText, isLeader, meta, peersOf, seedIfEmpty, type CollabSession, type Peer } from "./doc-collab";
import { liveSaveStep } from "./collab-logic";

/** Opens the doc's room once per doc id. Null until it answers; then the session, or null session for the single editor. */
export function useCollabSession(docId: string) {
  const [collab, setCollab] = useState<{ id: string; session: CollabSession | null } | null>(null);
  useEffect(() => {
    let live = true;
    let opened: CollabSession | null = null;
    setCollab(null);
    void connectCollab(docId).then((session) => {
      opened = session;
      if (live) setCollab({ id: docId, session });
      else if (session) { session.provider.destroy(); session.ydoc.destroy(); }
    });
    return () => { live = false; if (opened) { opened.provider.destroy(); opened.ydoc.destroy(); } };
  }, [docId]);
  return collab && collab.id === docId ? collab : null;
}

/** The editor extensions, the same on every page that opens a doc so the shared schema matches. */
export function docExtensions(session: CollabSession | null) {
  return session
    ? [
        StarterKit.configure({ undoRedo: false }), TaskList, TaskItem.configure({ nested: true }),
        Collaboration.configure({ document: session.ydoc, field: FIELD }),
        CollaborationCaret.configure({ provider: session.provider, user: { name: "Someone", color: "#e8590c" }, render: renderCaret }),
      ]
    : [StarterKit, TaskList, TaskItem.configure({ nested: true })];
}

/** Another person's caret with their name above it (styled in code, so no stylesheet is needed). */
export function renderCaret(user: Record<string, unknown>) {
  const colour = typeof user.color === "string" ? user.color : "#e8590c";
  const caret = document.createElement("span");
  caret.className = "collaboration-carets__caret";
  Object.assign(caret.style, { position: "relative", marginLeft: "-1px", marginRight: "-1px", borderLeft: `2px solid ${colour}`, wordBreak: "normal", pointerEvents: "none" });
  const label = document.createElement("span");
  label.className = "collaboration-carets__label";
  Object.assign(label.style, {
    position: "absolute", top: "-1.45em", left: "-2px", padding: "1px 6px", borderRadius: "4px 4px 4px 0", background: colour, color: "#fff",
    fontSize: "11px", fontWeight: "600", lineHeight: "1.4", whiteSpace: "nowrap", userSelect: "none",
  });
  label.textContent = typeof user.name === "string" ? user.name : "Someone";
  caret.append(label);
  return caret;
}

/**
 * A remote edit that lands in the same instant as a click can leave the editor's own
 * selection behind the caret the browser shows, and the next keystroke then goes to the
 * old place. Before each key and after each click, take the browser's caret if they differ.
 */
export function syncSelectionFromDom(view: EditorView) {
  const sel = view.dom.ownerDocument.getSelection();
  if (!sel?.anchorNode || !sel.focusNode || !view.dom.contains(sel.anchorNode) || !(view.state.selection instanceof TextSelection)) return;
  try {
    const anchor = view.posAtDOM(sel.anchorNode, sel.anchorOffset);
    const head = view.posAtDOM(sel.focusNode, sel.focusOffset);
    const cur = view.state.selection;
    if (cur.anchor !== anchor || cur.head !== head) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
  } catch {
    // A caret the editor cannot map (inside a widget) stays as it is.
  }
}

export const liveKeyDown = (view: EditorView, event: KeyboardEvent) => { if (!event.isComposing) syncSelectionFromDom(view); return false; };
export const liveDomEvents = { mouseup: (view: EditorView) => { setTimeout(() => { if (!view.isDestroyed) syncSelectionFromDom(view); }, 0); return false; } };

export type SaveState = "saved" | "saving" | "unsaved" | "conflict";
export interface RowDoc { id: string; version: number; text: string; title: string; content: unknown }

interface Options {
  doc: RowDoc;
  session: CollabSession | null;
  editor: Editor | null;
  /** After this client saved the row (live leader or single editor). */
  onSaved: (d: RowDoc) => void;
  /** Live only: another client saved the row (its version reached the room). */
  onRemoteSaved?: () => void;
  /** Single editor: extra fields to send with every save (the doc page sends its title). */
  soloExtra?: () => Record<string, unknown>;
  /** Single editor: the row was saved elsewhere. Default: show "conflict". */
  onSoloConflict?: (ctx: { setState: (s: SaveState) => void; setVersion: (v: number) => void; editor: Editor }) => Promise<void> | void;
  /** Live: the caret label. */
  user: { name: string; color: string };
  delayMs: number;
}

/**
 * The save loop for a doc editor. Live: one leader writes the row when the content hash
 * changed, and reconciles with the row every 15 s and on a version conflict. Solo: every
 * change is saved with the row version, as before co-editing existed.
 */
export function useCollabDoc(o: Options) {
  const { doc, session, editor } = o;
  const [state, setState] = useState<SaveState>("saved");
  const [peers, setPeers] = useState<Peer[]>([]);
  const version = useRef(doc.version);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opts = useRef(o);
  opts.current = o;

  const saved = (d: RowDoc) => {
    version.current = d.version;
    if (session) session.ydoc.transact(() => { const m = meta(session.ydoc); m.set("version", d.version); m.set("rowText", hashText(d.text)); });
    setState("saved");
    opts.current.onSaved(d);
  };

  /** Leader only: brings the room in line with the doc row when someone changed it elsewhere. */
  const reconcile = async (): Promise<"same" | "adopted" | "loaded"> => {
    if (!session || !editor) return "same";
    const row = (await api.get<{ doc: RowDoc }>(`/docs/${doc.id}`)).doc;
    const m = meta(session.ydoc);
    if (row.version === m.get("version")) return "same";
    if (hashText(row.text) === m.get("rowText")) {
      session.ydoc.transact(() => { m.set("version", row.version); if (row.title !== m.get("title")) m.set("title", row.title); });
      version.current = row.version;
      return "adopted";
    }
    editor.commands.setContent(row.content as never, { emitUpdate: false });
    session.ydoc.transact(() => {
      m.set("version", row.version); m.set("rowText", hashText(row.text));
      m.set("json", hashText(JSON.stringify(editor.getJSON()))); m.set("title", row.title);
    });
    version.current = row.version;
    setState("saved");
    return "loaded";
  };

  const save = async (patch: Record<string, unknown> = {}, retried = false): Promise<void> => {
    if (!editor) return;
    if (session) {
      const m = meta(session.ydoc);
      const json = editor.getJSON();
      const h = hashText(JSON.stringify(json));
      if (liveSaveStep({ leader: isLeader(session), hash: h, savedHash: m.get("json"), titlePatch: !!patch.title }) === "skip") { setState("saved"); return; }
      setState("saving");
      try {
        const r = await api.patch<{ doc: RowDoc }>(`/docs/${doc.id}`, { content: json, version: (m.get("version") as number | undefined) ?? version.current, ...patch });
        m.set("json", h);
        saved(r.doc);
      } catch (e) {
        if (e instanceof ApiError && e.code === "version_conflict" && !retried) {
          // Someone else wrote the row: keep our text if only the version moved, else load theirs.
          if ((await reconcile()) === "adopted") return save(patch, true);
          return;
        }
        setState("unsaved");
        showError(e as Error);
      }
      return;
    }
    setState("saving");
    try {
      const r = await api.patch<{ doc: RowDoc }>(`/docs/${doc.id}`, { content: editor.getJSON(), ...(opts.current.soloExtra?.() ?? {}), version: version.current, ...patch });
      saved(r.doc);
    } catch (e) {
      if (e instanceof ApiError && e.code === "version_conflict") {
        const handle = opts.current.onSoloConflict;
        if (handle) await handle({ setState, setVersion: (v) => { version.current = v; }, editor });
        else setState("conflict");
      } else { setState("unsaved"); showError(e as Error); }
    }
  };

  const schedule = () => {
    if (session && !isLeader(session)) return;
    setState("unsaved"); clearTimeout(timer.current); timer.current = setTimeout(() => void save(), opts.current.delayMs);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  // Live session: seed an empty room, follow presence, and keep the row in step while this client is the leader.
  useEffect(() => {
    if (!session || !editor) return;
    if (seedIfEmpty(session.ydoc, editor.schema, doc)) meta(session.ydoc).set("json", hashText(JSON.stringify(editor.getJSON())));
    else if (isLeader(session)) void reconcile().catch(() => undefined);
    const m = meta(session.ydoc);
    const onMeta = (ev: { keysChanged: Set<string> }, tr: { local: boolean }) => {
      if (!tr.local && ev.keysChanged.has("version")) opts.current.onRemoteSaved?.();
    };
    m.observe(onMeta);
    const onPresence = () => setPeers(peersOf(session));
    session.provider.awareness.on("change", onPresence);
    onPresence();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && isLeader(session)) void reconcile().catch(() => undefined);
    }, 15_000);
    return () => { m.unobserve(onMeta); session.provider.awareness.off("change", onPresence); clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, editor]);
  useEffect(() => {
    if (session && editor) editor.commands.updateUser({ name: o.user.name, color: o.user.color });
  }, [session, editor, o.user.name, o.user.color]);

  return { state, setState, peers, save, schedule, reconcile, saved, timer, version };
}
