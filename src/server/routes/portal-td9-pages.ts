/**
 * TD9: the client's pages for the access levels, projects, invoices, forms and threads (server rendered, escaped),
 * and the one same origin script that keeps a project page live (polls its JSON while the tab is visible).
 * No inline script, no third party script: the page Content-Security-Policy is unchanged.
 */
import { esc, sizeText } from "../services/tools/p2-public";
import { taskStateLabel, type PortalItem } from "@/shared/client-portal";
import { AREA_LABEL, canView, type PortalArea, type PortalLevel, type Td9Comment } from "@/shared/portal-td9";
import type { ProjectView } from "../services/portal/portal-td9";

export const TD9_CSS = `<style>
progress.pv{width:100%;height:10px;accent-color:var(--brand)}.priv{font-size:12px;font-weight:600;margin-top:4px}.bubble.me .priv{color:#fff}
.pv-status{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:18px}.pill.open{color:var(--muted)}
.list li a.t{color:var(--fg);text-decoration:none}.list li a.t:hover{text-decoration:underline}
</style>`;

export type Td9Tab = "home" | "projects" | "files" | "docs" | "tasks" | "invoices" | "forms" | "messages";
const ORDER: [Td9Tab, string, PortalArea | null][] = [["home", "Overview", null], ["projects", AREA_LABEL.projects, "projects"], ["files", AREA_LABEL.files, "files"], ["docs", AREA_LABEL.docs, "docs"],
  ["tasks", AREA_LABEL.tasks, "tasks"], ["invoices", AREA_LABEL.invoices, "invoices"], ["forms", AREA_LABEL.forms, "forms"], ["messages", "Messages", null]];

/** The tabs a person sees: Overview and Messages always, each area only at View or Comment. */
export function td9Tabs(levels: Record<PortalArea, PortalLevel>): [Td9Tab, string][] {
  return ORDER.filter(([, , a]) => !a || canView(levels[a])).map(([k, l]) => [k, l]);
}

const dateText = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", ...(iso.length === 10 ? { timeZone: "UTC" } : {}) });
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const pct = (p: { done: number; total: number } | undefined) => (p && p.total ? Math.round((p.done / p.total) * 100) : 0);

export function projectsBody(key: string, items: PortalItem[]) {
  const list = items.filter((i) => i.kind === "project");
  if (!list.length) return `<p class="empty">No projects shared yet.</p>`;
  return `<ul class="list" data-testid="portal-projects">${list.map((x) => `<li><div class="grow"><a class="t" href="/p/${esc(key)}/project/${esc(x.id)}">${esc(x.title)}</a><div class="meta">${pct(x.progress)}% done${x.progress?.total ? ` · ${x.progress.done} of ${x.progress.total} tasks` : ""}</div><progress class="pv" max="100" value="${pct(x.progress)}" aria-label="${esc(x.title)} progress">${pct(x.progress)}%</progress></div><a class="act" href="/p/${esc(key)}/project/${esc(x.id)}" data-testid="portal-project-open">Open</a></li>`).join("")}</ul>`;
}

export function invoicesBody(items: PortalItem[]) {
  const list = items.filter((i) => i.kind === "invoice");
  if (!list.length) return `<p class="empty">No invoices shared yet.</p>`;
  return `<ul class="list" data-testid="portal-invoices">${list.map((x) => `<li><div class="grow"><div class="t">${esc(x.title)}</div><div class="meta">${esc(x.amount ?? "")}${x.due ? ` · Due ${dateText(x.due)}` : ""}</div></div><span class="pill${x.status === "Paid" ? " done" : ""}">${esc(x.status ?? "Issued")}</span>${x.url ? `<a class="act" href="${esc(x.url)}">View</a>` : ""}</li>`).join("")}</ul>`;
}

export function formsBody(items: PortalItem[]) {
  const list = items.filter((i) => i.kind === "form");
  if (!list.length) return `<p class="empty">No forms shared yet.</p>`;
  return `<ul class="list" data-testid="portal-forms">${list.map((x) => `<li><div class="grow"><div class="t">${esc(x.title)}</div><div class="meta">Shared ${dateText(x.addedAt)}</div></div>${x.url ? `<a class="act primary" href="${esc(x.url)}">Fill in</a>` : ""}</li>`).join("")}</ul>`;
}

export function tasksBodyTd9(key: string, items: PortalItem[]) {
  const tasks = items.filter((i) => i.kind === "task");
  if (!tasks.length) return `<p class="empty">No updates shared yet.</p>`;
  return `<ul class="list" data-testid="portal-tasks">${tasks.map((x) => `<li><div class="grow"><a class="t" href="/p/${esc(key)}/t/${esc(x.id)}">${esc(x.title)}</a><div class="meta">${x.due ? `Due ${dateText(x.due)}` : "No due date"}</div></div><span class="pill ${esc(x.state ?? "todo")}">${taskStateLabel(x.state)}</span></li>`).join("")}</ul>`;
}

export function homeStatsTd9(key: string, items: PortalItem[], levels: Record<PortalArea, PortalLevel>) {
  const n = (k: string) => items.filter((i) => i.kind === k).length;
  const open = items.filter((i) => i.kind === "task" && i.state !== "done").length;
  const stats: string[] = [];
  const stat = (tab: string, num: number, one: string, many: string) => stats.push(`<a class="stat" href="/p/${esc(key)}?tab=${tab}"><b>${num}</b><span>${num === 1 ? one : many}</span></a>`);
  if (canView(levels.projects)) stat("projects", n("project"), "project", "projects");
  if (canView(levels.files)) stat("files", n("file"), "file", "files");
  if (canView(levels.docs)) stat("docs", n("doc"), "doc", "docs");
  if (canView(levels.tasks)) stat("tasks", open, "open task", "open tasks");
  if (canView(levels.invoices)) stat("invoices", n("invoice"), "invoice", "invoices");
  if (canView(levels.forms)) stat("forms", n("form"), "form", "forms");
  return stats.length ? `<div class="grid3">${stats.join("")}</div>` : "";
}

export function threadHtml(comments: Td9Comment[], id = "pv-comments") {
  return `<ol class="thread" id="${id}" data-testid="portal-comments">${comments.length ? comments.map((m) => `<li class="bubble${m.author.me ? " me" : ""}"><div class="who">${esc(m.author.name)} · ${when(m.at)}</div>${esc(m.body)}${m.privateLabel ? `<div class="priv" data-testid="portal-private">${esc(m.privateLabel)}</div>` : ""}</li>`).join("") : `<li class="empty">No comments yet.</li>`}</ol>`;
}

export function composerHtml(key: string, itemId: string, ft: string, canComment: boolean) {
  if (!canComment) return `<p class="muted small">You can read comments here. Ask the team if you need to reply.</p>`;
  return `<form method="post" action="/p/${esc(key)}/c/${esc(itemId)}"><input type="hidden" name="ft" value="${ft}"><label for="cbody">Add a comment</label><textarea id="cbody" name="body" required maxlength="4000" data-testid="portal-comment"></textarea><p class="muted small">Everyone on your team here and in this space can read it.</p><div class="form-row"><button class="act primary" type="submit" data-testid="portal-comment-send">Post comment</button></div></form>`;
}

function mRow(m: ProjectView["milestones"][number]) {
  return `<li><div class="grow"><div class="t">${esc(m.title)}</div><div class="meta">${m.due ? `Due ${dateText(m.due)}` : "No due date"}</div></div><span class="pill ${m.done ? "done" : "open"}">${m.done ? "Done" : "Open"}</span></li>`;
}

export function projectHtml(key: string, itemId: string, v: ProjectView, ft: string) {
  const sec = (id: string, title: string, inner: string) => `<section aria-labelledby="${id}-h"><h2 class="sec-h" id="${id}-h">${title}</h2>${inner}</section>`;
  const tasks = v.tasks === null ? "" : sec("pv-t", "Shared tasks", `<ul class="list" id="pv-tasks">${v.tasks.length ? v.tasks.map((t) => `<li><div class="grow"><a class="t" href="/p/${esc(key)}/t/${esc(t.id)}">${esc(t.title)}</a><div class="meta">${t.due ? `Due ${dateText(t.due)}` : "No due date"}</div></div><span class="pill ${esc(t.state)}">${taskStateLabel(t.state)}</span></li>`).join("") : `<li class="empty">No tasks shared from this project yet.</li>`}</ul>`);
  const files = v.files === null ? "" : sec("pv-f", "Files", `<ul class="list" id="pv-files">${v.files.length ? v.files.map((f) => `<li><div class="grow"><div class="t">${esc(f.title)}</div><div class="meta">${f.bytes ? sizeText(f.bytes) : ""}</div></div><a class="act" href="/p/${esc(key)}/f/${esc(f.id)}" download>Download</a></li>`).join("") : `<li class="empty">No files for this project yet.</li>`}</ul>`);
  return `<p><a href="/p/${esc(key)}?tab=projects">Back to projects</a></p><div class="card" data-testid="portal-project" data-live="/p/${esc(key)}/project/${esc(itemId)}/live.json" data-key="${esc(key)}">
<h1>${esc(v.title)}</h1>${v.description ? `<p class="lead" style="white-space:pre-wrap">${esc(v.description.slice(0, 1000))}</p>` : ""}
${sec("pv-p", "Progress", `<progress class="pv" id="pv-progress" max="100" value="${v.progress.pct}" aria-label="Project progress">${v.progress.pct}%</progress><p class="meta" id="pv-progress-text">${v.progress.pct}% done · ${v.progress.done} of ${v.progress.total} tasks</p>`)}
${sec("pv-m", "Milestones", `<ul class="list" id="pv-milestones">${v.milestones.length ? v.milestones.map(mRow).join("") : `<li class="empty">No milestones yet.</li>`}</ul>`)}
${tasks}${files}
${sec("pv-c", "Comments", `${threadHtml(v.comments)}${composerHtml(key, itemId, ft, v.canComment)}`)}
<div class="pv-status"><p class="meta" id="pv-status" role="status" aria-live="polite">Updated ${when(v.updatedAt)}. This page refreshes on its own.</p><button class="act" type="button" id="pv-retry" hidden>Retry</button></div></div>`;
}

export function taskHtml(key: string, itemId: string, t: { title: string; state: "todo" | "doing" | "done"; due: string | null; comments: Td9Comment[]; canComment: boolean }, ft: string) {
  return `<p><a href="/p/${esc(key)}?tab=tasks">Back to tasks</a></p><div class="card" data-testid="portal-task"><h1>${esc(t.title)}</h1>
<p><span class="pill ${esc(t.state)}">${taskStateLabel(t.state)}</span> <span class="meta">${t.due ? `Due ${dateText(t.due)}` : "No due date"}</span></p>
<section aria-labelledby="tc-h"><h2 class="sec-h" id="tc-h">Comments</h2>${threadHtml(t.comments, "tc-comments")}${composerHtml(key, itemId, ft, t.canComment)}</section></div>`;
}

/** The JSON the live script reads: plain values only, the script writes them with textContent. */
export function projectJson(key: string, v: ProjectView) {
  return {
    progress: v.progress, updatedAt: v.updatedAt,
    milestones: v.milestones.map((m) => ({ title: m.title, due: m.due, done: m.done })),
    tasks: v.tasks ? v.tasks.map((t) => ({ title: t.title, href: `/p/${key}/t/${t.id}`, state: t.state, stateLabel: taskStateLabel(t.state), due: t.due })) : null,
    files: v.files ? v.files.map((f) => ({ title: f.title, href: `/p/${key}/f/${f.id}`, size: f.bytes ? sizeText(f.bytes) : "" })) : null,
    comments: v.comments.map((m) => ({ who: m.author.name, me: m.author.me, at: m.at, body: m.body, priv: m.privateLabel })),
  };
}

export const LIVE_JS = `(function(){"use strict";
var root=document.querySelector("[data-live]");if(!root)return;
var url=root.getAttribute("data-live"),st=document.getElementById("pv-status"),rb=document.getElementById("pv-retry"),busy=false;
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function day(s){if(!s)return "";var d=new Date(s.length===10?s+"T00:00:00Z":s);return d.toLocaleDateString("en-AU",s.length===10?{day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}:{day:"numeric",month:"short",year:"numeric"})}
function at(s){return new Date(s).toLocaleString("en-AU",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"})}
function fill(id,list,row,empty){var u=document.getElementById(id);if(!u||!list)return;while(u.firstChild)u.removeChild(u.firstChild);if(!list.length){u.appendChild(el("li","empty",empty));return}list.forEach(function(i){u.appendChild(row(i))})}
function line(title,meta,href){var g=el("div","grow");var t=href?el("a","t",title):el("div","t",title);if(href)t.setAttribute("href",href);g.appendChild(t);g.appendChild(el("div","meta",meta));return g}
function render(d){
var p=document.getElementById("pv-progress");if(p){p.value=d.progress.pct;p.textContent=d.progress.pct+"%"}
var pt=document.getElementById("pv-progress-text");if(pt)pt.textContent=d.progress.pct+"% done \\u00b7 "+d.progress.done+" of "+d.progress.total+" tasks";
fill("pv-milestones",d.milestones,function(m){var li=el("li");li.appendChild(line(m.title,m.due?"Due "+day(m.due):"No due date"));li.appendChild(el("span","pill "+(m.done?"done":"open"),m.done?"Done":"Open"));return li},"No milestones yet.");
fill("pv-tasks",d.tasks,function(t){var li=el("li");li.appendChild(line(t.title,t.due?"Due "+day(t.due):"No due date",t.href));li.appendChild(el("span","pill "+t.state,t.stateLabel));return li},"No tasks shared from this project yet.");
fill("pv-files",d.files,function(f){var li=el("li");li.appendChild(line(f.title,f.size));var a=el("a","act","Download");a.setAttribute("href",f.href);a.setAttribute("download","");li.appendChild(a);return li},"No files for this project yet.");
fill("pv-comments",d.comments,function(m){var li=el("li","bubble"+(m.me?" me":""));li.appendChild(el("div","who",m.who+" \\u00b7 "+at(m.at)));li.appendChild(document.createTextNode(m.body));if(m.priv)li.appendChild(el("div","priv",m.priv));return li},"No comments yet.");
}
function tick(){if(busy||document.hidden)return;busy=true;
fetch(url,{credentials:"same-origin",headers:{accept:"application/json"}}).then(function(r){if(r.status===401||r.status===404){location.reload();return null}if(!r.ok)throw new Error("status");return r.json()}).then(function(d){busy=false;if(!d)return;render(d);st.textContent="Updated "+at(d.updatedAt)+". This page refreshes on its own.";rb.hidden=true}).catch(function(){busy=false;st.textContent=navigator.onLine===false?"You are offline. Showing the last update.":"Could not refresh. Showing the last update.";rb.hidden=false})}
if(rb)rb.addEventListener("click",function(){tick()});
document.addEventListener("visibilitychange",function(){if(!document.hidden)tick()});
window.addEventListener("online",tick);window.addEventListener("offline",function(){st.textContent="You are offline. Showing the last update.";rb.hidden=false});
setInterval(tick,20000);
})();`;
