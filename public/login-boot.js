/* Multies R34: the prerendered sign in page starts the app's code here, once the card has painted.
   The card is already in the HTML with its CSS inline, so the code (about 210 KB) waits one frame instead of
   sharing a slow connection with the HTML, the CSS and the font. A file, not an inline script, so the CSP is unchanged. */
(function () {
  var me = document.currentScript;
  if (!me) return;
  var entry = me.getAttribute("data-entry");
  var preloads = (me.getAttribute("data-preload") || "").split(" ").filter(Boolean);
  function start() {
    for (var i = 0; i < preloads.length; i++) {
      var l = document.createElement("link");
      l.rel = "modulepreload";
      l.crossOrigin = "";
      l.href = preloads[i];
      document.head.appendChild(l);
    }
    var s = document.createElement("script");
    s.type = "module";
    s.crossOrigin = "";
    s.src = entry;
    document.head.appendChild(s);
  }
  if (!entry) return;
  // R35: a tap on the drawn card before the app takes over (about a second on a slow phone) is kept and replayed
  // on the live button with the same test id or label, so the first tap on "Continue with Multies" is never lost.
  var pending = null;
  document.addEventListener("click", function (e) {
    var root = document.getElementById("root");
    if (!root || !root.hasAttribute("data-prerendered")) return;
    var t = e.target;
    var b = t && t.closest ? t.closest("button") : null;
    if (!b || !root.contains(b)) return;
    e.preventDefault();
    e.stopPropagation();
    pending = { id: b.getAttribute("data-testid"), text: (b.textContent || "").trim() };
    b.setAttribute("aria-busy", "true");
  }, true);
  function replay() {
    if (!pending) return;
    var root = document.getElementById("root");
    var found = null;
    var list = root ? root.querySelectorAll("button") : [];
    for (var i = 0; i < list.length && !found; i++) {
      var c = list[i];
      if ((pending.id && c.getAttribute("data-testid") === pending.id) || (!pending.id && (c.textContent || "").trim() === pending.text)) found = c;
    }
    pending = null;
    if (found) found.click();
  }
  if (typeof MutationObserver === "function") {
    var rootEl = document.getElementById("root");
    if (rootEl) {
      var mo = new MutationObserver(function () {
        if (rootEl.hasAttribute("data-prerendered")) return;
        mo.disconnect();
        // Give React its commit, then press the live button.
        setTimeout(replay, 50);
      });
      mo.observe(rootEl, { attributes: true, attributeFilter: ["data-prerendered"] });
    }
  }
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(function () { setTimeout(start, 0); });
  else setTimeout(start, 0);
})();
