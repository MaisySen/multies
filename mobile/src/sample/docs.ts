import { ApiError } from "@/api/errors";
import type { Method } from "@/api/transport";
import type { CommentView, PMNode, ShareLink, TreeNode } from "@/lib/docs";
import type { SearchGroup, SearchItem, SearchType } from "@/lib/global-search";

/** M1: Docs, comments, share links and global search in the sample workspace, in memory only. */
export interface SampleDocs {
  docs: { id: string; title: string; parentId: string | null; position: number; kind: string; content: PMNode; updatedAt: string }[];
  comments: Record<string, CommentView[]>;
  links: Record<string, ShareLink[]>;
  seq: number;
}

const t = (text: string, marks?: string[]): PMNode => ({ type: "text", text, ...(marks ? { marks: marks.map((m) => (m.startsWith("http") ? { type: "link", attrs: { href: m } } : { type: m })) } : {}) });
const p = (...c: PMNode[]): PMNode => ({ type: "paragraph", content: c });
const h = (level: number, text: string): PMNode => ({ type: "heading", attrs: { level }, content: [t(text)] });
const li = (text: string): PMNode => ({ type: "listItem", content: [p(t(text))] });
const task = (text: string, checked: boolean): PMNode => ({ type: "taskItem", attrs: { checked }, content: [p(t(text))] });
const cell = (text: string, header = false): PMNode => ({ type: header ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [p(t(text))] });

export function sampleDocs(now: number): SampleDocs {
  const at = (mins: number) => new Date(now - mins * 60_000).toISOString();
  const plan: PMNode = {
    type: "doc", content: [
      h(2, "Goals for this quarter"),
      p(t("We open the "), t("Sydney office", ["bold"]), t(" in March and move every client to the "), t("new onboarding", ["italic"]), t(". Details are on "), t("our site", ["https://multies.si"]), t(".")),
      { type: "bulletList", content: [li("Hire two support people"), li("Ship the phone app update"), li("Cut reply time under two hours")] },
      { type: "orderedList", attrs: { start: 1, type: null }, content: [li("Sign the lease"), li("Order desks"), li("Move in")] },
      h(3, "Checklist"),
      { type: "taskList", content: [task("Budget approved", true), task("Lease signed", false), task("Phones ordered", false)] },
      { type: "blockquote", content: [p(t("Small steps every week beat one big push."))] },
      { type: "callout", attrs: { variant: "warning" }, content: [p(t("The lease offer ends on 30 November."))] },
      { type: "table", content: [
        { type: "tableRow", content: [cell("Item", true), cell("Owner", true), cell("Cost", true)] },
        { type: "tableRow", content: [cell("Desks"), cell("Priya"), cell("$4,200")] },
        { type: "tableRow", content: [cell("Phones"), cell("Sam"), cell("$1,800")] },
      ] },
      { type: "codeBlock", attrs: { language: "text" }, content: [t("Office hours: 8:30 to 5:30\nSupport line: 1300 000 000")] },
      { type: "whiteboard", attrs: { id: "wb1", scene: JSON.stringify([{ type: "text", text: "Floor plan" }, { type: "text", text: "Kitchen by the window" }]), page: false, height: 420 } },
      { type: "horizontalRule" },
      p(t("Last updated by the team.")),
      p(),
    ],
  };
  const notes: PMNode = { type: "doc", content: [h(2, "Weekly sync"), p(t("Agenda and notes from Monday.")), { type: "bulletList", content: [li("Hiring update"), li("Office move")] }, p()] };
  const empty: PMNode = { type: "doc", content: [p()] };
  return {
    docs: [
      { id: "doc_plan", title: "Quarter plan", parentId: null, position: 1, kind: "doc", content: plan, updatedAt: at(30) },
      { id: "doc_meet", title: "Meeting notes", parentId: null, position: 2, kind: "doc", content: notes, updatedAt: at(120) },
      { id: "doc_sync", title: "Weekly sync, 27 Oct", parentId: "doc_meet", position: 1, kind: "doc", content: notes, updatedAt: at(3000) },
      { id: "doc_board", title: "Office floor plan", parentId: "doc_plan", position: 1, kind: "whiteboard", content: empty, updatedAt: at(600) },
      { id: "doc_empty", title: "", parentId: null, position: 3, kind: "doc", content: empty, updatedAt: at(9000) },
    ],
    comments: {
      doc_plan: [
        { id: "cmt_1", thread: "team", body: "Can we move the office date to April?", status: "visible", author: { type: "member", name: "Priya Shah" }, createdAt: at(50), editedAt: null, mine: false, canEdit: false, canRemove: true },
        { id: "cmt_2", thread: "team", body: "March works. The lease is ready.", status: "visible", author: { type: "member", name: "You" }, createdAt: at(40), editedAt: null, mine: true, canEdit: true, canRemove: true },
      ],
    },
    links: {},
    seq: 10,
  };
}

const plain = (n: PMNode | undefined): string => (!n ? "" : n.type === "text" ? n.text ?? "" : (n.content ?? []).map(plain).join(" "));

function tree(s: SampleDocs): TreeNode[] {
  const node = (d: SampleDocs["docs"][number], depth: number): TreeNode => ({
    id: d.id, title: d.title, parentId: d.parentId, position: d.position, projectId: null, updatedAt: d.updatedAt, depth,
    children: s.docs.filter((c) => c.parentId === d.id).map((c) => node(c, depth + 1)), ...(d.kind === "whiteboard" ? { kind: "whiteboard" as const } : {}),
  });
  return s.docs.filter((d) => !d.parentId).map((d) => node(d, 1));
}

const notFound = () => new ApiError(404, "not_found", "Doc not found.");

/** Answers the M1 paths, or undefined for paths that are not these. */
export function docsRoute(s: SampleDocs, messages: { id: string; subject: string; folder: string; mailboxId: string; from: { name?: string | null; address: string }; date: string }[],
  method: Method, path: string, params: Record<string, string>, body: unknown, now: number): unknown {
  const parts = path.split("/").filter(Boolean);
  if (path === "/search" && method === "GET") {
    const q = (params.q ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 100);
    if (q.length < 2) throw new ApiError(422, "validation_failed", "Type at least 2 characters to search.");
    const types = (params.types ?? "").split(",").filter(Boolean) as SearchType[];
    const want = (x: SearchType) => !types.length || types.includes(x);
    const limit = Math.min(Number(params.limit) || 5, 20);
    const words = q.split(" ");
    const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w));
    const groups: SearchGroup[] = [];
    if (want("mail")) {
      const items: SearchItem[] = messages.filter((m) => hit(`${m.subject} ${m.from.name ?? ""} ${m.from.address}`)).slice(0, limit)
        .map((m) => ({ type: "mail", id: m.id, title: m.subject, subtitle: m.from.name || m.from.address, snippet: "", url: `/app/mail?mailbox=${m.mailboxId}&folder=${m.folder}&m=${m.id}`, at: m.date }));
      if (items.length) groups.push({ type: "mail", label: "Mail", items });
    }
    if (want("docs")) {
      const items: SearchItem[] = s.docs.filter((d) => hit(`${d.title} ${plain(d.content)}`)).slice(0, limit)
        .map((d) => ({ type: "docs", id: d.id, title: d.title || "Untitled", subtitle: "Doc", snippet: plain(d.content).slice(0, 120), url: `/app/docs/${d.id}`, at: d.updatedAt }));
      if (items.length) groups.push({ type: "docs", label: "Docs", items });
    }
    if (want("contacts") && hit("priya shah priya@example.com")) groups.push({ type: "contacts", label: "Contacts", items: [{ type: "contacts", id: "con_priya", title: "Priya Shah", subtitle: "Harbour Studio", snippet: "", url: "/app/contacts/con_priya", at: null }] });
    if (want("deals") && hit("harbour studio fit out")) groups.push({ type: "deals", label: "Deals", items: [{ type: "deals", id: "deal_1", title: "Harbour Studio fit out", subtitle: "Proposal", snippet: "", url: "/app/deals?deal=deal_1", at: null }] });
    return { query: q, groups, tookMs: 3, partial: false };
  }
  if (parts[0] === "docs") {
    if (path === "/docs/tree" && method === "GET") return { tree: tree(s), count: s.docs.length, truncated: false, maxDepth: 10 };
    if (parts.length === 2 && method === "GET") {
      const d = s.docs.find((x) => x.id === parts[1]);
      if (!d) throw notFound();
      return { doc: { id: d.id, title: d.title, kind: d.kind, projectId: null, parentId: d.parentId, content: d.content, text: plain(d.content), createdBy: { type: "user", id: "usr_me" }, createdAt: d.updatedAt, updatedAt: d.updatedAt, version: 3, links: [] } };
    }
    return undefined;
  }
  if (parts[0] === "docs-plus") {
    if (parts[1] === "docs" && parts[3] === "comments") {
      const id = parts[2];
      if (!s.docs.some((d) => d.id === id)) throw notFound();
      const list = (s.comments[id] ??= []);
      if (method === "GET") return { team: list.filter((c) => c.thread === "team"), public: list.filter((c) => c.thread === "public"), pending: 0, canModerate: true, publicOn: false };
      if (method === "POST") {
        const text = String((body as { body?: string })?.body ?? "").trim();
        if (!text) throw new ApiError(422, "validation_failed", "Write a comment first.");
        const c: CommentView = { id: `cmt_${++s.seq}`, thread: "team", body: text, status: "visible", author: { type: "member", name: "You" }, createdAt: new Date(now).toISOString(), editedAt: null, mine: true, canEdit: true, canRemove: true };
        list.push(c);
        return { comment: c };
      }
    }
    if (parts[1] === "comments" && parts[2]) {
      for (const list of Object.values(s.comments)) {
        const i = list.findIndex((c) => c.id === parts[2]);
        if (i < 0) continue;
        if (method === "DELETE") { list.splice(i, 1); return { ok: true }; }
        if (method === "PATCH") {
          const b = (body ?? {}) as { body?: string; status?: CommentView["status"] };
          if (b.body !== undefined) list[i] = { ...list[i], body: b.body.trim(), editedAt: new Date(now).toISOString() };
          if (b.status) list[i] = { ...list[i], status: b.status };
          return { comment: list[i] };
        }
      }
      throw new ApiError(404, "not_found", "Comment not found.");
    }
    return undefined;
  }
  if (parts[0] === "share-links") {
    if (method === "GET" && parts.length === 1) {
      const id = params.targetId ?? "";
      return { links: s.links[id] ?? [], allowShareLinks: true };
    }
    if (method === "POST" && parts.length === 1) {
      const b = (body ?? {}) as { targetId?: string; expiresInDays?: number | null; showWorkspaceName?: boolean };
      const id = b.targetId ?? "";
      const link: ShareLink = { id: `shl_${++s.seq}`, kind: "doc", targetId: id, showWorkspaceName: b.showWorkspaceName ?? true, createdBy: "usr_me", createdAt: new Date(now).toISOString(),
        expiresAt: b.expiresInDays ? new Date(now + b.expiresInDays * 86_400_000).toISOString() : null, comments: "off" };
      (s.links[id] ??= []).unshift(link);
      return { link: { ...link, url: `https://multies.si/s/sample${s.seq}` } };
    }
    if (method === "DELETE" && parts[1]) {
      for (const k of Object.keys(s.links)) s.links[k] = s.links[k].filter((l) => l.id !== parts[1]);
      return { ok: true };
    }
  }
  return undefined;
}
