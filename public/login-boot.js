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
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(function () { setTimeout(start, 0); });
  else setTimeout(start, 0);
})();
