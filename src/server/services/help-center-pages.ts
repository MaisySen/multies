/**
 * R122: the public help center pages, rendered on the server (readable without JavaScript; forms are plain POSTs).
 * Every value is escaped; article bodies are the escaped snapshot from renderDocHtml.
 */
import { esc } from "./tools/p2-public";
import { helpfulPercent } from "@/shared/help-center";
import type { LiveCenter, SearchHit } from "./help-center";

export interface PageMeta { title: string; description: string; canonical: string; noindex?: boolean }

const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--muted:#5f5f68;--line:#e4e4e7;--card:#fff;--soft:#f4f4f5;--brand:#0a66d8;--brand-ink:#fff;--good:#1a7f37;--focus:#0a66d8}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--fg:#f4f4f5;--muted:#a1a1aa;--line:#2e2e33;--card:#161618;--soft:#1f1f22;--brand:#4c9dff;--brand-ink:#08111f;--good:#3fb950;--focus:#7cb8ff}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}
.skip{position:absolute;left:-999px}.skip:focus{left:12px;top:12px;background:var(--card);padding:8px 12px;z-index:9}
header.top{border-bottom:1px solid var(--line);background:var(--card)}
.bar{max-width:880px;margin:0 auto;padding:12px 24px;display:flex;align-items:center;gap:12px;min-height:56px}
.home{font-weight:600;color:var(--fg);letter-spacing:-.01em}.home span{color:var(--muted);font-weight:400}
.bar nav{margin-left:auto;display:flex;gap:4px}.bar nav a{color:var(--muted);padding:10px 12px;border-radius:8px;font-size:15px}.bar nav a:hover{background:var(--soft);text-decoration:none;color:var(--fg)}
main{max-width:880px;margin:0 auto;padding:32px 24px 64px}
.hero{padding:16px 0 8px}.hero h1{font-size:32px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em}.hero p{color:var(--muted);margin:0 0 20px;font-size:17px}
form.search{display:flex;gap:8px;margin:0 0 32px}form.search input{flex:1;min-width:0}
input,textarea{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 14px;min-height:44px;width:100%}
textarea{min-height:120px;resize:vertical}input:focus,textarea:focus{border-color:var(--focus);outline:2px solid color-mix(in srgb,var(--focus) 30%,transparent);outline-offset:0}
label{display:block;font-weight:600;font-size:14px;margin:16px 0 6px}.hint{color:var(--muted);font-size:13px;margin:4px 0 0}
button,.btn{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 18px;min-height:44px;background:var(--brand);color:var(--brand-ink);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}
button.ghost,.btn.ghost{background:var(--soft);color:var(--fg)}button:hover,.btn:hover{filter:brightness(1.06);text-decoration:none}
h2{font-size:20px;margin:32px 0 12px;letter-spacing:-.01em}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;color:var(--fg);transition:border-color .15s,transform .15s}
a.card:hover{border-color:var(--brand);text-decoration:none}
.card h3{margin:0 0 4px;font-size:16px}.card p{margin:0;color:var(--muted);font-size:14px}
ul.list{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:12px;background:var(--card);overflow:hidden}
ul.list li+li{border-top:1px solid var(--line)}ul.list a{display:block;padding:14px 18px;color:var(--fg)}ul.list a:hover{background:var(--soft);text-decoration:none}
ul.list .t{font-weight:600;display:block}ul.list .s{color:var(--muted);font-size:14px;display:block;overflow-wrap:anywhere}
.meta{color:var(--muted);font-size:13px}.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px;background:var(--soft);color:var(--muted);margin-right:6px}
.pill.ok{color:var(--good)}
.crumbs{font-size:14px;color:var(--muted);margin:0 0 16px}.crumbs a{color:var(--muted)}
article.doc{font-size:17px;line-height:1.7;overflow-wrap:anywhere}article.doc h1{font-size:30px;line-height:1.25;margin:0 0 8px;letter-spacing:-.02em}
article.doc img{max-width:100%;height:auto;border-radius:8px}article.doc pre{background:var(--soft);padding:12px 14px;border-radius:8px;overflow:auto;font-size:14px}
article.doc table{border-collapse:collapse;display:block;overflow-x:auto}article.doc td,article.doc th{border:1px solid var(--line);padding:6px 10px}
article.doc blockquote{margin:0;padding-left:14px;border-left:3px solid var(--line);color:var(--muted)}
.box{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-top:32px}
.box h2{margin:0 0 12px;font-size:17px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.notice{background:color-mix(in srgb,var(--good) 12%,var(--card));border:1px solid color-mix(in srgb,var(--good) 40%,var(--line));border-radius:10px;padding:12px 14px;margin:0 0 20px}
.err{color:#c62828;font-weight:600}@media (prefers-color-scheme:dark){.err{color:#ff8a80}}
.answer{display:flex;gap:14px;padding:16px 0;border-top:1px solid var(--line)}.answer:first-child{border-top:0}
.votes{display:flex;flex-direction:column;align-items:center;min-width:48px}.votes form{margin:0}
.votes button{background:var(--soft);color:var(--fg);min-width:44px;padding:6px}.votes b{font-size:15px;margin-top:2px}
.qbody{white-space:pre-wrap;overflow-wrap:anywhere}.accepted{border:1px solid color-mix(in srgb,var(--good) 45%,var(--line));border-radius:12px;padding:16px;background:color-mix(in srgb,var(--good) 6%,var(--card))}
.pager{display:flex;justify-content:space-between;margin-top:20px}.hp{position:absolute;left:-5000px;width:1px;height:1px;overflow:hidden}
footer{max-width:880px;margin:0 auto;padding:0 24px 40px;color:var(--muted);font-size:13px}
@media (max-width:640px){.bar{padding:10px 16px}.bar nav a{padding:10px 8px}main{padding:20px 16px 48px}.hero h1{font-size:26px}.grid{grid-template-columns:1fr}article.doc{font-size:16px}article.doc h1{font-size:24px}.answer{gap:10px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export function layout(c: LiveCenter, base: string, meta: PageMeta, body: string, active?: "home" | "questions" | "ask") {
  const name = c.s.name || c.orgName;
  const nav = [
    `<a href="${base}"${active === "home" ? ' aria-current="page"' : ""}>Articles</a>`,
    ...(c.s.qaOn ? [`<a href="${base}/questions"${active === "questions" ? ' aria-current="page"' : ""}>Questions</a>`, `<a href="${base}/ask"${active === "ask" ? ' aria-current="page"' : ""}>Ask</a>`] : []),
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title><meta name="description" content="${esc(meta.description.slice(0, 160))}">
<link rel="canonical" href="${esc(meta.canonical)}"><meta name="robots" content="${meta.noindex ? "noindex, nofollow" : "index, follow"}">
<meta property="og:title" content="${esc(meta.title)}"><meta property="og:description" content="${esc(meta.description.slice(0, 160))}"><meta property="og:url" content="${esc(meta.canonical)}"><meta property="og:type" content="website">
<meta name="referrer" content="strict-origin-when-cross-origin"><style>${CSS}</style></head>
<body><a class="skip" href="#main">Skip to content</a><header class="top"><div class="bar"><a class="home" href="${base}">${esc(name)} <span>Help center</span></a><nav aria-label="Help center">${nav}</nav></div></header>
<main id="main">${body}</main><footer>Help center of ${esc(c.orgName)}</footer></body></html>`;
}

export const searchForm = (base: string, q = "") =>
  `<form class="search" role="search" method="get" action="${base}/search"><label for="q" class="hp">Search</label><input id="q" name="q" type="search" value="${esc(q)}" placeholder="Search for answers" maxlength="200" autocomplete="off"><button type="submit">Search</button></form>`;

const cardList = (base: string, items: { slug: string; title: string; summary: string }[]) =>
  `<ul class="list">${items.map((a) => `<li><a href="${base}/a/${esc(a.slug)}"><span class="t">${esc(a.title)}</span>${a.summary ? `<span class="s">${esc(a.summary)}</span>` : ""}</a></li>`).join("")}</ul>`;

const ago = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : "");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function homePage(c: LiveCenter, base: string, data: { categories: { name: string; slug: string; description: string; articles: number }[]; popular: { slug: string; title: string; summary: string }[]; questions: { id: string; title: string; votes: number; answerCount: number; accepted: string | null }[] }) {
  const name = c.s.name || c.orgName;
  const empty = !data.categories.length && !data.popular.length && !data.questions.length;
  const body = `<section class="hero"><h1>How can we help?</h1><p>${esc(c.s.intro || `Answers and guides from ${c.orgName}.`)}</p>${searchForm(base)}</section>
${empty ? `<div class="box"><h2>Nothing here yet</h2><p class="meta">This help center has no articles yet.${c.s.qaOn ? ` You can <a href="${base}/ask">ask a question</a>.` : ""}</p></div>` : ""}
${data.categories.length ? `<h2>Topics</h2><div class="grid">${data.categories.map((t) => `<a class="card" href="${base}/c/${esc(t.slug)}"><h3>${esc(t.name)}</h3><p>${esc(t.description || plural(t.articles, "article", "articles"))}</p></a>`).join("")}</div>` : ""}
${data.popular.length ? `<h2>Popular articles</h2>${cardList(base, data.popular)}` : ""}
${data.questions.length ? `<h2>Recent questions</h2>${questionList(base, data.questions)}<p><a href="${base}/questions">All questions</a></p>` : ""}`;
  return layout(c, base, { title: `${name} help center`, description: c.s.intro || `Answers and guides from ${c.orgName}.`, canonical: base }, body, "home");
}

function questionList(base: string, qs: { id: string; title: string; votes: number; answerCount: number; accepted: string | null }[]) {
  return `<ul class="list">${qs.map((q) => `<li><a href="${base}/q/${esc(q.id)}"><span class="t">${esc(q.title)}</span><span class="s">${q.accepted ? '<span class="pill ok">Answered</span>' : ""}${plural(q.votes, "vote", "votes")} · ${plural(q.answerCount, "answer", "answers")}</span></a></li>`).join("")}</ul>`;
}

export function categoryPage(c: LiveCenter, base: string, page: number, data: { category: { name: string; slug: string; description: string }; articles: { slug: string; title: string; summary: string }[]; more: boolean }) {
  const url = `${base}/c/${data.category.slug}`;
  const body = `<p class="crumbs"><a href="${base}">Help center</a> / ${esc(data.category.name)}</p><section class="hero"><h1>${esc(data.category.name)}</h1>${data.category.description ? `<p>${esc(data.category.description)}</p>` : ""}</section>
${cardList(base, data.articles)}${pager(url, page, data.more, "")}`;
  return layout(c, base, { title: `${data.category.name} · ${c.s.name || c.orgName} help center`, description: data.category.description || `Articles about ${data.category.name}.`, canonical: page > 1 ? `${url}?page=${page}` : url }, body);
}

function pager(url: string, page: number, more: boolean, extra: string) {
  if (page <= 1 && !more) return "";
  const sep = url.includes("?") ? "&" : "?";
  return `<nav class="pager" aria-label="Pages">${page > 1 ? `<a class="btn ghost" href="${url}${sep}${extra}page=${page - 1}">Newer</a>` : "<span></span>"}${more ? `<a class="btn ghost" href="${url}${sep}${extra}page=${page + 1}">More</a>` : ""}</nav>`;
}

export function articlePage(c: LiveCenter, base: string, a: { slug: string; title: string; summary: string; bodyHtml: string; updatedAt: number; category: { name: string; slug: string } | null; related: { slug: string; title: string; summary: string }[] }, form: { ft: string; ts: string }, state: { thanks?: boolean }) {
  const url = `${base}/a/${a.slug}`;
  const feedback = state.thanks
    ? `<div class="box" id="feedback" role="status"><h2>Thanks for telling us</h2><p class="meta">It helps us make this page better.</p></div>`
    : `<form class="box" id="feedback" method="post" action="${url}/feedback"><h2>Was this helpful?</h2>${hidden(form)}
<label for="fc">What was missing? <span class="meta">(optional, only our team sees it)</span></label><textarea id="fc" name="comment" maxlength="1000" rows="3"></textarea>
<div class="row" style="margin-top:12px"><button type="submit" name="helpful" value="yes">Yes, it helped</button><button type="submit" name="helpful" value="no" class="ghost">Not really</button></div></form>`;
  const body = `<p class="crumbs"><a href="${base}">Help center</a>${a.category ? ` / <a href="${base}/c/${esc(a.category.slug)}">${esc(a.category.name)}</a>` : ""}</p>
<article class="doc"><h1>${esc(a.title)}</h1><p class="meta">Updated ${ago(a.updatedAt)}</p>${a.bodyHtml}</article>${feedback}
${a.related.length ? `<h2>Related articles</h2>${cardList(base, a.related)}` : ""}${c.s.qaOn ? `<p class="meta" style="margin-top:24px">Still stuck? <a href="${base}/ask">Ask a question</a></p>` : ""}`;
  return layout(c, base, { title: `${a.title} · ${c.s.name || c.orgName}`, description: a.summary || a.title, canonical: url }, body);
}

const hidden = (f: { ft: string; ts: string }) => `<input type="hidden" name="ft" value="${esc(f.ft)}"><input type="hidden" name="ts" value="${esc(f.ts)}"><div class="hp" aria-hidden="true"><label for="hp-w">Leave this empty</label><input id="hp-w" name="website" tabindex="-1" autocomplete="off"></div>`;

export function searchPage(c: LiveCenter, base: string, q: string, page: number, r: { hits: SearchHit[]; more: boolean; terms: string[] }) {
  const url = `${base}/search?q=${encodeURIComponent(q)}`;
  const body = `<section class="hero"><h1>Search</h1>${searchForm(base, q)}</section>
${!r.terms.length ? `<p class="meta">Type a few words to search.</p>` : r.hits.length ? `<p class="meta" role="status">Results for “${esc(q)}”</p><ul class="list">${r.hits.map((h) => `<li><a href="${base}/${esc(h.path)}"><span class="t">${h.kind === "question" ? '<span class="pill">Question</span>' : ""}${esc(h.title)}</span><span class="s">${esc(h.snippet)}</span></a></li>`).join("")}</ul>${pager(url, page, r.more, "")}`
    : `<div class="box" role="status"><h2>No results for “${esc(q)}”</h2><p class="meta">Try other words${c.s.qaOn ? `, or <a href="${base}/ask">ask a question</a>` : ""}.</p></div>`}`;
  return layout(c, base, { title: `Search · ${c.s.name || c.orgName} help center`, description: "Search the help center.", canonical: `${base}/search`, noindex: true }, body);
}

export function questionsPage(c: LiveCenter, base: string, sort: "top" | "new", page: number, r: { questions: { id: string; title: string; votes: number; answerCount: number; accepted: string | null }[]; more: boolean }) {
  const url = `${base}/questions?sort=${sort}`;
  const tab = (s: "top" | "new", label: string) => `<a class="btn ${s === sort ? "" : "ghost"}" href="${base}/questions?sort=${s}"${s === sort ? ' aria-current="page"' : ""}>${label}</a>`;
  const body = `<section class="hero"><h1>Questions</h1><p>Questions from people like you, answered by the team and the community.</p></section>
<div class="row" style="margin-bottom:16px">${tab("new", "Newest")}${tab("top", "Most votes")}<a class="btn" style="margin-left:auto" href="${base}/ask">Ask a question</a></div>
${r.questions.length ? questionList(base, r.questions) : `<div class="box"><h2>No questions yet</h2><p class="meta">Be the first to <a href="${base}/ask">ask one</a>.</p></div>`}${pager(url, page, r.more, "")}`;
  return layout(c, base, { title: `Questions · ${c.s.name || c.orgName} help center`, description: `Questions and answers about ${c.orgName}.`, canonical: page > 1 ? `${base}/questions?page=${page}` : `${base}/questions` }, body, "questions");
}

export function questionPage(c: LiveCenter, base: string, q: { id: string; title: string; body: string; authorName: string; votes: number; publishedAt: number | null; acceptedAnswerId: string | null; answers: { id: string; body: string; authorKind: string; authorName: string; votes: number; createdAt: number }[] }, form: { ft: string; ts: string }, state: { notice?: string; error?: string }) {
  const url = `${base}/q/${q.id}`;
  const voteForm = (kind: "q" | "a", id: string, n: number, label: string) => `<div class="votes"><form method="post" action="${url}/vote">${hidden(form)}<input type="hidden" name="target" value="${kind}:${esc(id)}"><button type="submit" aria-label="${label}" title="${label}">▲</button></form><b aria-label="${plural(n, "vote", "votes")}">${n}</b></div>`;
  const ans = q.answers.map((x) => `<div class="answer${x.id === q.acceptedAnswerId ? " accepted" : ""}" id="a-${esc(x.id)}">${voteForm("a", x.id, x.votes, "Vote for this answer")}<div style="min-width:0;flex:1">${x.id === q.acceptedAnswerId ? '<p><span class="pill ok">Best answer</span></p>' : ""}<div class="qbody">${esc(x.body)}</div><p class="meta">${x.authorKind === "team" ? `${esc(x.authorName || "Team")} <span class="pill">Team</span>` : esc(x.authorName || "A visitor")} · ${ago(x.createdAt)}</p></div></div>`).join("");
  const body = `<p class="crumbs"><a href="${base}">Help center</a> / <a href="${base}/questions">Questions</a></p>
${state.notice ? `<div class="notice" role="status">${esc(state.notice)}</div>` : ""}${state.error ? `<p class="err" role="alert">${esc(state.error)}</p>` : ""}
<div class="answer" style="border:0;padding-top:0">${voteForm("q", q.id, q.votes, "Vote for this question")}<div style="min-width:0;flex:1"><h1 style="margin:0 0 8px;font-size:26px;line-height:1.3">${esc(q.title)}</h1>${q.body ? `<div class="qbody">${esc(q.body)}</div>` : ""}<p class="meta">${esc(q.authorName || "A visitor")} · ${ago(q.publishedAt)}</p></div></div>
<h2>${q.answers.length ? plural(q.answers.length, "answer", "answers") : "No answers yet"}</h2>${ans}
<form class="box" method="post" action="${url}/answer"><h2>Your answer</h2>${hidden(form)}<label for="ab">Answer</label><textarea id="ab" name="body" required minlength="10" maxlength="8000"></textarea>
<label for="an">Your name <span class="meta">(optional)</span></label><input id="an" name="name" maxlength="60" autocomplete="nickname">
<p class="hint">${c.s.moderate ? "The team checks answers before they show here." : "Your answer shows here once you post it."}</p><div class="row" style="margin-top:12px"><button type="submit">Post answer</button></div></form>`;
  const desc = (q.body || q.answers[0]?.body || q.title).replace(/\s+/g, " ");
  return layout(c, base, { title: `${q.title} · ${c.s.name || c.orgName}`, description: desc, canonical: url }, body, "questions");
}

export function askPage(c: LiveCenter, base: string, form: { ft: string; ts: string }, state: { error?: string; title?: string; body?: string; name?: string; done?: "pending" | "live" }) {
  const body = state.done === "pending"
    ? `<section class="hero"><h1>Thanks, we have your question</h1><p>The team checks new questions first. It shows in the help center once they have.</p></section><div class="row"><a class="btn" href="${base}">Back to the help center</a><a class="btn ghost" href="${base}/ask">Ask another</a></div>`
    : `<section class="hero"><h1>Ask a question</h1><p>Search first: your answer may be there already.</p>${searchForm(base)}</section>
<form class="box" method="post" action="${base}/ask">${hidden(form)}${state.error ? `<p class="err" role="alert">${esc(state.error)}</p>` : ""}
<label for="qt">Your question</label><input id="qt" name="title" required minlength="8" maxlength="160" value="${esc(state.title ?? "")}" placeholder="How do I ...">
<label for="qb">Details <span class="meta">(optional)</span></label><textarea id="qb" name="body" maxlength="4000">${esc(state.body ?? "")}</textarea><p class="hint">Do not include passwords, card numbers or your email address. Everyone can read questions.</p>
<label for="qn">Your name <span class="meta">(optional)</span></label><input id="qn" name="name" maxlength="60" autocomplete="nickname" value="${esc(state.name ?? "")}">
<div class="row" style="margin-top:16px"><button type="submit">Post question</button></div></form>`;
  return layout(c, base, { title: `Ask a question · ${c.s.name || c.orgName} help center`, description: "Ask the team a question.", canonical: `${base}/ask`, noindex: true }, body, "ask");
}

export function missingPage(title = "This page doesn't exist", text = "Check the address and try again.") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body><main id="main"><div class="box"><h1 style="margin:0 0 8px;font-size:24px">${esc(title)}</h1><p class="meta">${esc(text)}</p></div></main></body></html>`;
}

export function sitemapXml(base: string, d: { arts: { slug: string; updatedAt: number }[]; qs: { id: string; updatedAt: number }[]; cats: { slug: string }[] }) {
  const u = (loc: string, t?: number) => `<url><loc>${esc(loc)}</loc>${t ? `<lastmod>${new Date(t).toISOString().slice(0, 10)}</lastmod>` : ""}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${u(base)}${d.cats.map((c) => u(`${base}/c/${c.slug}`)).join("")}${d.arts.map((a) => u(`${base}/a/${a.slug}`, a.updatedAt)).join("")}${d.qs.map((q) => u(`${base}/q/${q.id}`, q.updatedAt)).join("")}</urlset>`;
}

export { helpfulPercent };
