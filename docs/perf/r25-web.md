# Round 25: web app speed (internal)

Measured 25 October 2026 on the build box (4 CPUs, shared with other builds running at the same time, so
timings carry noise of roughly 10 percent). Before is main 93dc6c7; after is branch r25-web.

## How it was measured

- Bundle: `npm run build:web`, then `node scripts/bundle-stats-r25.mjs` (sizes from dist/web; gzip level 9
  and brotli from Node's zlib).
- Pages: `node scripts/perf-web-r25.mjs 3` against the local node server (`npx tsx src/entry/node.ts`
  with the E2E environment, which compresses static files with gzip). Each load starts with an empty
  cache in a fresh browser context, signed in for app pages. Desktop is 1440 x 900 with no throttling;
  phone is 390 x 844, touch, with 4x CPU throttling. Median of 3 loads. First contentful paint from
  `performance.getEntriesByName("first-contentful-paint")`, LCP from a buffered PerformanceObserver,
  JS transferred is the sum of transferSize over script resources until the network is idle plus 0.5 s.
- Before and after were measured back to back on the same server by swapping dist/web.
- Lighthouse was not used: the Playwright script installs nothing and runs in about 2 minutes.

## Bundle

| | Before | After |
|---|---|---|
| JS chunks | 154 | 177 |
| Total JS raw / gzip / brotli (KB) | 4056.3 / 1263.8 / 1085.8 | 4076.5 / 1274.3 / 1093.9 |
| Entry chunk raw / gzip / brotli (KB) | 441 / 138.1 / 116.5 | 171.4 / 54.6 / 45.8 |
| JS in index.html (entry plus modulepreload): files, raw / gzip / brotli (KB) | 6, 567.8 / 180.4 / 154.3 | 5, 481.9 / 152 / 130.2 |

The entry got smaller because React and the router moved to their own long lived chunk (vendor-react,
cached across releases) and because sign-in, sign-up, pricing, the agents page and the OAuth consent page
now load on their own: the landing page no longer carries the auth client. Total JS is flat by design
(the same code, cut differently).

Largest 10 chunks before (KB raw, gzip):

| Chunk | Raw | Gzip |
|---|---|---|
| call-dock-r23-CV5JQZ4H.js | 646.9 | 172.7 |
| index-DMDf0aEU.js | 441 | 138.1 |
| esm-BBImoaUh.js | 439.1 | 145.5 |
| dist-CTrj_o_2.js | 388.9 | 121.6 |
| PieChart-BdyMle9T.js | 364.5 | 103.2 |
| timeline-DoCzWopY.js | 269.2 | 84.6 |
| calendar-DVLVFwdl.js | 228.2 | 67.6 |
| meeting-notes-Be0zB34_.js | 153.9 | 48.5 |
| lib-DLGWhq4E.js | 92.4 | 29.8 |
| tasks-CqtMU8Hy.js | 77.9 | 21.1 |

Largest 10 chunks after:

| Chunk | Raw | Gzip |
|---|---|---|
| vendor-calls-6nJ3OyGI.js | 642.9 | 171.1 |
| vendor-editor-BEY6JmZ2.js | 516.7 | 160.7 |
| vendor-sentry-BrkNJlb9.js | 427.5 | 142.1 |
| vendor-charts-DlmYGsIC.js | 389.4 | 108.3 |
| vendor-react-DI-5FaLm.js | 306.3 | 95.3 |
| vendor-gantt-5YDAssA6.js | 267.2 | 83.8 |
| vendor-calendar-BO4ElfMh.js | 223 | 65.6 |
| index-Ck1qPNkL.js | 171.4 | 54.6 |
| tasks-BgRmu1S4.js | 78.9 | 21.4 |
| app-BzKQpGBJ.js | 77.1 | 25 |

## Pages (ms, KB)

| Profile | Page | FCP before | FCP after | LCP before | LCP after | JS before | JS after |
|---|---|---|---|---|---|---|---|
| desktop | / | 220 | 212 | 220 | 212 | 183.1 | 154.7 |
| desktop | /app | 484 | 468 | 812 | 776 | 255.5 | 366.7 |
| desktop | /app/tasks | 480 | 456 | 480 | 456 | 310.8 | 363 |
| desktop | /app/mail | 536 | 460 | 836 | 760 | 307.4 | 363 |
| desktop | /app/chat | 556 | 468 | 896 | 796 | 263.7 | 373.3 |
| phone | / | 744 | 664 | 744 | 664 | 183.1 | 154.7 |
| phone | /app | 1132 | 820 | 1380 | 1088 | 255.5 | 366.7 |
| phone | /app/tasks | 1148 | 892 | 1620 | 1268 | 310.8 | 363 |
| phone | /app/mail | 1000 | 868 | 1280 | 1156 | 307.4 | 363 |
| phone | /app/chat | 912 | 848 | 1352 | 1280 | 263.7 | 373.3 |

On the phone profile LCP dropped by 80 to 350 ms on the app pages and FCP by 60 to 310 ms: the opened
page's chunk now starts loading beside the app frame (main.tsx) instead of after the frame has rendered.
JS transferred on app pages went up by about 50 to 110 KB because, once the browser is idle, the app now
fetches the My Work, Tasks and Mail chunks ahead of a click (that is the point: the next page opens from
cache). On the landing page JS fell from 183 to 155 KB.

## What changed

- Code split: every route page is lazy except the landing page (kept in the entry so `/` paints with no
  second round trip) and not-found. Sign-in and the other auth pages, pricing, agents and OAuth consent
  became lazy. Big libraries got named chunks through Rolldown's codeSplitting groups in vite.config.ts
  (vendor-react, vendor-editor for Tiptap, ProseMirror and Yjs, vendor-charts for recharts, vendor-calls for
  LiveKit, vendor-calendar, vendor-gantt, vendor-dnd, vendor-sentry) with includeDependenciesRecursively off,
  so a group never drags its small shared helpers (clsx and the like) into the first load. Tiptap and Yjs
  share one group: split apart, their circular imports ran out of order and the Docs page threw
  "is not a constructor".
- Preload: src/web/lib/prefetch.ts. The opened page's chunk starts at boot; hover, focus or touch on any
  link to one of our pages warms that page; My Work, Tasks and Mail load when the browser is idle after
  the first page shows (skipped on Save-Data or 2G). Vite already writes modulepreload links for the
  entry's static imports (vendor-react, the icon helper, cn).
- Preconnect: none added. The app only calls its own origin; Sentry starts after idle and LiveKit only on
  a call, so a preconnect at load would open sockets most visits never use.
- Fonts: the Inter and JetBrains Mono faces already declare font-display: swap (13 faces in the CSS).
- Caching: the Worker already sends `public, max-age=31536000, immutable` for /assets/*. The self hosted
  node server sent none; it now sends the same header for /assets/* (src/entry/node.ts).
