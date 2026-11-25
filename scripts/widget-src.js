/* Multies website chat. Paste: <script src="https://APP/widget.js" data-key="KEY" async></script> */
(function () {
  "use strict";
  var s = document.currentScript || document.querySelector("script[data-key][src*='widget.js']");
  if (!s || window.__mqChat) return;
  window.__mqChat = 1;
  var key = s.getAttribute("data-key") || "";
  var base = new URL(s.src).origin;
  var api = base + "/api/widget/" + encodeURIComponent(key);
  var store = "mq_chat_" + key;
  var st = { open: false, cfg: null, token: null, last: 0, msgs: {}, timer: 0, typingAt: 0, mode: "chat", asked: false, status: "open" };
  try { var saved = JSON.parse(localStorage.getItem(store) || "null"); if (saved && saved.token) st.token = saved.token; } catch (_e) { /* private mode */ }

  var host = document.createElement("div");
  host.setAttribute("data-mq-chat", "");
  host.style.cssText = "position:fixed;z-index:2147483000;right:16px;bottom:16px";
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  document.body.appendChild(host);

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) { if (k === "text") n.textContent = attrs[k]; else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]); else n.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function req(method, path, body) {
    var h = { "content-type": "application/json" };
    if (st.token) h["x-visitor-token"] = st.token;
    return fetch(api + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, credentials: "omit", mode: "cors" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && j.error && j.error.message) || (j && j.message) || "Something went wrong. Try again."); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function ink(hex) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? "#111827" : "#ffffff";
  }

  var css = el("style", { text: [
    ":host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}",
    ".fab{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:var(--c);color:var(--i);box-shadow:0 6px 20px rgba(0,0,0,.2);display:grid;place-items:center}",
    ".fab:focus-visible,button:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid var(--c);outline-offset:2px}",
    ".panel{position:absolute;right:0;bottom:68px;width:360px;height:min(560px,calc(100vh - 100px));background:var(--bg);color:var(--fg);border:1px solid var(--ln);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden;font-size:14px;line-height:1.45}",
    ".hd{background:var(--c);color:var(--i);padding:14px 16px;display:flex;align-items:flex-start;gap:8px}.hd h2{font-size:16px;margin:0;font-weight:600}.hd p{margin:2px 0 0;font-size:12.5px;opacity:.9}",
    ".x{margin-left:auto;background:transparent;border:0;color:inherit;width:44px;height:44px;margin:-10px -10px -10px auto;border-radius:10px;cursor:pointer;font-size:22px;line-height:1}",
    ".log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}",
    ".m{max-width:82%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}.me{align-self:flex-end;background:var(--c);color:var(--i);border-bottom-right-radius:4px}",
    ".them{align-self:flex-start;background:var(--soft);border-bottom-left-radius:4px}.who{font-size:11.5px;color:var(--mu);margin:0 0 2px}",
    ".bot{border:1px dashed var(--ln);background:transparent}.note{align-self:center;font-size:12.5px;color:var(--mu);text-align:center;max-width:90%}",
    ".typing{font-size:12.5px;color:var(--mu);padding:0 14px 6px;min-height:18px}",
    ".ft{border-top:1px solid var(--ln);padding:10px;display:flex;gap:8px;align-items:flex-end}",
    "textarea,input{width:100%;border:1px solid var(--ln);border-radius:10px;padding:10px;font-size:14px;background:var(--bg);color:var(--fg);resize:none}",
    "textarea{min-height:44px;max-height:120px}label{display:block;font-size:12.5px;font-weight:600;margin:10px 0 4px}",
    ".b{min-height:44px;padding:0 14px;border-radius:10px;border:0;background:var(--c);color:var(--i);font-weight:600;cursor:pointer;font-size:14px}",
    ".ghost{background:transparent;color:var(--fg);border:1px solid var(--ln);font-weight:500}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}",
    ".form{padding:14px;overflow-y:auto;flex:1}.sug p{margin:8px 0 2px;font-size:12.5px;color:var(--mu)}.sug a{display:block;padding:6px 0;color:var(--fg);font-size:13.5px;text-decoration:underline}.err{color:#b91c1c;font-size:12.5px;margin:6px 0 0;min-height:0}.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}",
    ".card{align-self:stretch;border:1px solid var(--ln);border-radius:12px;padding:10px 12px}",
    ":host{--bg:#fff;--fg:#111827;--mu:#4b5563;--ln:#e5e7eb;--soft:#f3f4f6}",
    "@media (prefers-color-scheme:dark){:host{--bg:#171a21;--fg:#f3f4f6;--mu:#a1a1aa;--ln:#2f3542;--soft:#242934}.err{color:#fca5a5}}",
    "@media (max-width:480px){.panel{position:fixed;inset:0;width:auto;height:100%;border-radius:0;bottom:0}}",
    "@media (prefers-reduced-motion:no-preference){.panel{animation:in .18s ease-out}@keyframes in{from{opacity:0;transform:translateY(8px)}}}"
  ].join("") });
  root.appendChild(css);

  var fab = el("button", { "class": "fab", type: "button", "aria-label": "Open chat", "aria-expanded": "false", onclick: toggle });
  fab.innerHTML = '<svg width="26" height="26" viewBox="0 0 256 256" aria-hidden="true" fill="currentColor"><path d="M128 24a104 104 0 0 0-91.8 152.9l-11.4 34a16 16 0 0 0 20.3 20.3l34-11.4A104 104 0 1 0 128 24Z"/></svg>';
  host.style.setProperty("--c", "#4338ca"); host.style.setProperty("--i", "#ffffff");
  root.appendChild(fab);
  var panel = null, log = null, typingEl = null, input = null, errEl = null;

  function setColor(c) { host.style.setProperty("--c", c); host.style.setProperty("--i", ink(c)); }
  function save() { try { localStorage.setItem(store, JSON.stringify({ token: st.token })); } catch (_e) { /* ignore */ } }
  function fmtTime(iso) { try { return new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }); } catch (_e) { return ""; } }

  function toggle() { if (st.open) close(); else open(); }
  function close() {
    st.open = false; fab.setAttribute("aria-expanded", "false"); fab.setAttribute("aria-label", "Open chat");
    if (panel) panel.hidden = true;
    clearTimeout(st.timer); fab.focus();
  }
  function open() {
    st.open = true; fab.setAttribute("aria-expanded", "true"); fab.setAttribute("aria-label", "Close chat");
    if (panel) { panel.hidden = false; focusFirst(); poll(); return; }
    req("GET", "/config").then(function (cfg) { st.cfg = cfg; setColor(cfg.color || "#4338ca"); build(); }).catch(function (e) { buildError(e.message); });
  }
  function focusFirst() { var f = panel && panel.querySelector("textarea,input:not(.hp),button.b"); if (f) f.focus(); }
  function header() {
    var c = st.cfg;
    var sub = c.online ? "We usually reply in a few minutes" : c.nextOpenAt ? "We are away. Back " + fmtTime(c.nextOpenAt) : "We are away right now";
    return el("div", { "class": "hd" }, [el("div", {}, [el("h2", { id: "mq-t", text: c.title }), el("p", { text: sub })]), el("button", { "class": "x", type: "button", "aria-label": "Close chat", onclick: close, text: "\u00d7" })]);
  }
  function shell(kids) {
    if (panel) panel.remove();
    panel = el("div", { "class": "panel", role: "dialog", "aria-modal": "false", "aria-labelledby": "mq-t" }, kids);
    panel.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    root.appendChild(panel);
    focusFirst();
  }
  function buildError(msg) {
    st.cfg = st.cfg || { title: "Chat", online: false };
    shell([header(), el("div", { "class": "form" }, [el("p", { text: msg || "The chat is not available right now." })])]);
  }
  function build() {
    if (st.token) return chatView();
    if (!st.cfg.online) return offlineForm(false);
    if (st.cfg.askEmail === "before") return startForm();
    chatView();
  }
  function field(id, label, type, req2, auto) {
    return [el("label", { "for": id, text: label }), el(type === "area" ? "textarea" : "input", type === "area" ? { id: id, rows: "4", maxlength: "2000" } : { id: id, type: type, autocomplete: auto || "off", maxlength: type === "email" ? "254" : "80" })];
  }
  function offlineForm(chosen) {
    st.mode = "offline";
    errEl = el("p", { "class": "err", role: "alert" });
    var hp = el("input", { "class": "hp", tabindex: "-1", "aria-hidden": "true", autocomplete: "off", id: "mq-hp" });
    var intro = chosen ? "Leave a message and we will reply by email." : "We are away right now. Leave a message and we will reply by email.";
    var form = el("form", { "class": "form", novalidate: "" }, [el("p", { text: intro })].concat(field("mq-n", "Name", "text", false, "name"), field("mq-e", "Email", "email", true, "email"), field("mq-m", "Message", "area", true), [hp, errEl, el("div", { "class": "row" }, [el("button", { "class": "b", type: "submit", text: "Send message" })])]));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = root.getElementById ? root.getElementById("mq-e").value : form.querySelector("#mq-e").value;
      var text = form.querySelector("#mq-m").value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { errEl.textContent = "Add your email so we can reply."; return; }
      if (!text.trim()) { errEl.textContent = "Write a message first."; return; }
      req("POST", "/chats", { name: form.querySelector("#mq-n").value, email: email, text: text, page: location.href, hp: hp.value, offline: true }).then(function (r) {
        st.token = r.token; save();
        shell([header(), el("div", { "class": "form" }, [el("p", { role: "status", text: "Thanks. Your message reached the team and we will reply to " + email + "." })])]);
      }).catch(function (er) { errEl.textContent = er.message; });
    });
    shell([header(), form]);
  }
  function startForm() {
    errEl = el("p", { "class": "err", role: "alert" });
    var sug = el("div", { "class": "sug", "aria-live": "polite" }); // R122: help center articles that may answer it
    var form = el("form", { "class": "form", novalidate: "" }, [el("p", { text: st.cfg.greeting })].concat(field("mq-n", "Name", "text", false, "name"), field("mq-e", "Email", "email", true, "email"), field("mq-m", "Message", "area", true), [sug, errEl, el("div", { "class": "row" }, [el("button", { "class": "b", type: "submit", text: "Start chat" })])]));
    var sugT = 0, sugQ = "";
    form.querySelector("#mq-m").addEventListener("input", function (e) {
      var v = e.target.value.trim();
      clearTimeout(sugT);
      sugT = setTimeout(function () {
        if (v.length < 4 || v === sugQ) return;
        sugQ = v;
        req("GET", "/help?q=" + encodeURIComponent(v.slice(0, 200))).then(function (r) {
          while (sug.firstChild) sug.removeChild(sug.firstChild);
          var list = (r && r.articles) || [];
          if (!list.length) return;
          sug.appendChild(el("p", { text: "These might answer it:" }));
          list.forEach(function (a) { sug.appendChild(el("a", { href: a.url, target: "_blank", rel: "noopener", text: a.title })); });
        }).catch(function () {});
      }, 450);
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = form.querySelector("#mq-e").value, text = form.querySelector("#mq-m").value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { errEl.textContent = "Add your email to start the chat."; return; }
      if (!text.trim()) { errEl.textContent = "Write a message first."; return; }
      req("POST", "/chats", { name: form.querySelector("#mq-n").value, email: email, text: text, page: location.href }).then(function (r) {
        st.token = r.token; save(); st.asked = true; chatView(); render(r);
      }).catch(function (er) { errEl.textContent = er.message; });
    });
    shell([header(), form]);
  }
  function chatView() {
    st.mode = "chat"; st.msgs = {}; st.last = 0;
    log = el("div", { "class": "log", role: "log", "aria-live": "polite", "aria-label": "Messages" });
    if (!st.token) log.appendChild(el("div", { "class": "m them", text: st.cfg.greeting }));
    typingEl = el("div", { "class": "typing", "aria-live": "polite" });
    errEl = el("p", { "class": "err", role: "alert", style: "padding:0 14px" });
    input = el("textarea", { rows: "1", placeholder: "Write a message", "aria-label": "Message", maxlength: "2000" });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    input.addEventListener("input", function () {
      var t = Date.now();
      if (st.token && t - st.typingAt > 3000) { st.typingAt = t; req("POST", "/chats/me/typing").catch(function () {}); }
    });
    var foot = el("div", { "class": "ft" }, [input, el("button", { "class": "b", type: "button", onclick: send, text: "Send" })]);
    var leave = st.cfg.online && !st.token ? el("div", { style: "padding:0 14px 8px" }, [el("button", { "class": "b ghost", type: "button", onclick: function () { offlineForm(true); }, text: "Leave a message instead" })]) : null;
    shell([header(), log, typingEl, errEl, leave, foot]);
    if (st.token) poll();
  }
  function bubble(m) {
    if (m.author === "system" && m.text === "csat") return csatCard();
    var mine = m.author === "visitor";
    var who = m.author === "agent" ? (m.name || "Team") : m.author === "bot" ? "Automatic answer from our saved replies" : null;
    var box = el("div", { "class": "m " + (mine ? "me" : "them") + (m.author === "bot" ? " bot" : "") }, [who ? el("p", { "class": "who", text: who }) : null, el("span", { text: m.text })]);
    return box;
  }
  function csatCard() {
    var card = el("div", { "class": "card" }, [el("p", { style: "margin:0", text: "How did we do?" })]);
    var row = el("div", { "class": "row", role: "group", "aria-label": "Your rating" });
    [["great", "Great"], ["okay", "Okay"], ["bad", "Not good"]].forEach(function (o) {
      row.appendChild(el("button", { "class": "b ghost", type: "button", text: o[1], onclick: function () {
        req("POST", "/chats/me/rating", { rating: o[0] }).then(function () { card.replaceChildren(el("p", { style: "margin:0", role: "status", text: "Thanks for telling us." })); }).catch(function (e) { errEl.textContent = e.message; });
      } }));
    });
    card.appendChild(row);
    return card;
  }
  function emailCard() {
    var inp = el("input", { type: "email", autocomplete: "email", "aria-label": "Your email", placeholder: "you@example.com" });
    var card = el("div", { "class": "card" }, [el("p", { style: "margin:0 0 6px", text: "Leave your email in case we reply after you go." }), inp,
      el("div", { "class": "row" }, [el("button", { "class": "b", type: "button", text: "Save email", onclick: function () {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(inp.value)) { errEl.textContent = "That email does not look right."; return; }
        req("POST", "/chats/me/email", { email: inp.value }).then(function () { card.replaceChildren(el("p", { style: "margin:0", role: "status", text: "Thanks. We will reply there if you leave." })); }).catch(function (e) { errEl.textContent = e.message; });
      } })])]);
    return card;
  }
  function render(r) {
    if (!log) return;
    (r.messages || []).forEach(function (m) {
      if (st.msgs[m.id]) return;
      st.msgs[m.id] = 1; st.last = Math.max(st.last, m.at);
      log.appendChild(bubble(m));
    });
    if (!st.asked && !r.hasEmail && st.cfg.askEmail === "after" && (r.messages || []).some(function (m) { return m.author === "visitor"; })) { st.asked = true; log.appendChild(emailCard()); }
    typingEl.textContent = r.agentTyping ? "The team is typing" : "";
    log.scrollTop = log.scrollHeight;
  }
  function send() {
    var text = input.value.trim();
    if (!text) return;
    errEl.textContent = "";
    input.disabled = true;
    var p = st.token ? req("POST", "/chats/me/messages", { text: text }) : req("POST", "/chats", { text: text, page: location.href }).then(function (r) { st.token = r.token; save(); return r; });
    p.then(function (r) { input.value = ""; render(r); schedule(); }).catch(function (e) {
      if (e.status === 401) { st.token = null; save(); }
      errEl.textContent = e.message;
    }).then(function () { input.disabled = false; input.focus(); });
  }
  function schedule() { clearTimeout(st.timer); if (st.open && st.token) st.timer = setTimeout(poll, document.hidden ? 15000 : 3000); }
  function poll() {
    if (!st.open || !st.token || st.mode !== "chat") return;
    req("GET", "/chats/me?after=" + st.last).then(render).catch(function (e) { if (e.status === 401) { st.token = null; save(); } }).then(schedule);
  }
})();
