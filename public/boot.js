/* R45 (MB-203): runs from the page before any app code, only on /app pages.
 * 1. Starts the reads every app page needs (the account, the public config, and My Work on My Work) now,
 *    beside the code, instead of after the app frame's code has loaded. lib/api.ts takes each answer once.
 * 2. Starts the app frame's and My Work's code (modulepreload) beside the entry, instead of after it has run.
 * 3. Draws a shell in the final layout (frame, the dated title, skeleton cards) so the first paint does not
 *    wait for the code. React replaces it on its first render.
 * No inline script (the CSP allows only the theme script's hash), so this is a small file loaded async. */
(function () {
  var p = location.pathname;
  if (p.indexOf("/app") !== 0 || !window.fetch) return;
  var early = window.__mmEarly = {};
  function go(path) {
    var r = fetch("/api" + path, { credentials: "same-origin" });
    r.catch(function () { /* lib/api.ts retries */ });
    early[path] = { at: Date.now(), res: r };
  }
  var myWork = /^\/app\/my-work\/?$/.test(p);
  go("/account/me");
  go("/config");
  if (myWork) go("/my-work");
  // The build writes the app frame's and My Work's files here (scripts/prerender-landing.ts); null in dev.
  // They start once the stylesheet is in, so the shell paints first; the reads above already hold their place.
  var chunks = /*R45_CHUNKS*/null;
  function preload() {
    if (!chunks) return;
    var files = (chunks.frame || []).concat(myWork ? chunks["/app/my-work"] || [] : []);
    for (var k = 0; k < files.length; k++) {
      if (document.querySelector('link[href="/' + files[k] + '"], script[src="/' + files[k] + '"]')) continue;
      var l = document.createElement("link");
      l.rel = "modulepreload";
      l.href = "/" + files[k];
      l.crossOrigin = "anonymous";
      document.head.appendChild(l);
    }
  }
  var css = document.querySelector('link[rel="stylesheet"]');
  if (!css || css.sheet) preload();
  else { css.addEventListener("load", preload); css.addEventListener("error", preload); }
  function shell() {
  var root = document.getElementById("root");
  if (!root || root.firstChild) return;
  var rows = "";
  for (var i = 0; i < 6; i++) rows += '<div class="skeleton mb-3 h-6 w-full"></div>';
  var cards = "";
  for (var j = 0; j < 4; j++) cards += '<div class="skeleton h-28"></div>';
  var head = "";
  if (myWork) {
    var day = "";
    try { day = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }); } catch (e) { /* old browser */ }
    head = '<p class="text-[13px] font-semibold uppercase tracking-[0.04em] text-[#0071E3] dark:text-brand-hover"><span>My Work</span><span aria-hidden="true"> · </span><span class="text-muted">' + day + '</span></p>' +
      '<div class="skeleton mt-2 mb-6 h-9 w-56"></div>';
  } else head = '<div class="skeleton mb-6 h-7 w-48"></div>';
  // The shell's few words use the system font, so the web font (50 KB) does not start before the code on a slow link.
  root.innerHTML = '<div class="flex min-h-dvh" aria-busy="true" aria-label="Loading" data-boot-shell="" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">' +
    '<div class="hidden w-60 border-r border-line bg-surface p-4 lg:block"><div class="skeleton mb-8 h-7 w-28"></div>' + rows + "</div>" +
    '<div class="min-w-0 flex-1 px-4 pt-6 sm:p-8">' + head + '<div class="grid grid-cols-2 gap-3 md:grid-cols-4">' + cards + "</div>" +
    '<div class="skeleton mt-5 h-48"></div></div></div>';
  }
  if (document.getElementById("root")) shell();
  else document.addEventListener("DOMContentLoaded", shell);
})();
