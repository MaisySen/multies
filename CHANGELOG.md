# Changelog

All notable changes to Multies. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). Before 1.0.0 each build round is a minor
version. Round dates are UTC. Rounds 1 to 9 were reconstructed from `git log` after the fact, so their
boundaries are approximate; from round 10 on, this file is updated in the same release.


## MPT-11 Boards show "N waiting in Triage" with a link (2026-11-25)

- On the board and the list of a project with Triage on, a line "N waiting in Triage" shows above the tasks when N is more than 0. The line links to the Triage page, filtered to the project.
- The line is hidden when N is 0, when Triage is off, and when the count read fails (for example, without a workspace session).
- `GET /api/triage/count` takes an optional `projectId`. With it, the count covers the pending items of that project only, without snoozed items. Without it, the answer is the same as before. The public API and MCP do not change.
- The text is in English, Hindi and Nepali. The count refreshes when the Triage page accepts or declines an item.

## VID2 Call videos: pause, speaker or gallery view, crash safe, chat and transcript files (2026-11-03)

- Pause and resume while recording (flag VIDEO_REC_VID2, needs VIDEO_REC_VID1; no migration, no new binding, nothing uploaded): MediaRecorder pause keeps paused time out of the file, the banner, a dot on every tile and a pill in the call header switch to Paused for everyone, and the transcript mix goes silent while paused.
- Speaker view (the person talking large with a 1.5 s hold, others in a strip) or gallery view, picked before and switched while recording; a screen share always takes the big area. 720p30 at 4 Mbps by default, 1080p30 at 8 Mbps on devices with 4 cores and 4 GB; the drawing steps down to 24, 20 or 15 fps when frames come late.
- Crash safe: every second of video is also kept in IndexedDB on the device; after a crash or a closed tab, Recover last recording rebuilds the file (meeting page and in the call); pieces are removed once saved and after 7 days.
- The call's chat is saved next to the video as "<video name> chat.txt", and the transcript as "<video name> transcript.txt" once ready (Save transcript on the meeting page too). Saving shows the size; leaving the call stops and saves on its own.
- MB-351: the call hangs up only when the page really goes (pagehide), never on a beforeunload the page survives; the banner clears for everyone when the person recording leaves; recording signals are said again shortly after each change so every banner matches.

## VID1 Save a video of the call on your own device (2026-11-03)

- Owners and admins save a video of the whole call (flag VIDEO_REC_VID1; no migration, no new binding): every camera and screen share drawn on a canvas in the browser (grid, names, active speaker, a shared screen large), all voices mixed, recorded as webm (vp9 or vp8 with opus) or mp4 where only that is supported, and saved as one file on the admin's device (written as the call goes where the browser can choose a file, else kept in the tab with a warning at 1.5 GB and a stop at 2 GB). Nothing is uploaded.
- Everyone in the call sees the Recording video banner; a warning before closing the tab while a video records; members keep today's audio Record and the video permit answers 403; the audio transcript and summary are unchanged. The compositor and recorder load only when an admin starts a video.

## SOC1 Several Facebook Pages and LinkedIn accounts (2026-11-03)

- Several Facebook Pages per workspace (flag SOCIAL_MULTI_SOC1; migration 0163 social_pages_soc1): after a Facebook connect an admin picks which Pages to add from every Page the login manages (paged past 100, search, Select all), each Page is its own post target with its picture, dedupe by Page id across logins, add or remove Pages later without reconnecting, lost Pages named with Reconnect.
- Several LinkedIn members as separate rows (dedupe by member id); company Pages only when LinkedIn organization access is granted on the connection, else an honest needs LinkedIn approval note.
- Composer: targets grouped per network with Select all, last choice remembered per user; scheduled posts keep their targets; result sheet, status check, Removed on network check and Delete per Page. Server code lazy (social-pages-soc1.ts). Flag off is unchanged.
- What's new: Several Facebook Pages and LinkedIn accounts ("2026-11-02-polish" moved to the public earlier list; list stays 14).

## TD9 Client portal access (2026-11-03)

- Client portal access per person per area (flag PORTAL_TD9, needs CLIENT_PORTAL; migration 0160 portal_td9): projects, tasks, files, docs, invoices and forms at None, View or Comment; defaults keep today (files, docs, tasks View; new areas None); every change audited as portal.access.set with a history in the Access dialog.
- Share projects, issued invoices or quotes and enabled forms into a portal; live project page /p/<key>/project/<item> with progress, milestones, shared tasks and linked files, refreshed every 20 s by a same origin script (/p/_/live-td9.js), offline keeps the last update with Retry; task page /p/<key>/t/<item>.
- Threads on shared tasks and projects (clients post with Comment) and a private comment to one member or client, seen only by its author, its target, owners and admins (separate table, filtered in SQL, no counts). Page CSP unchanged.

## TD7 Forms pro B (2026-11-03)

- Forms pro (flag FORMS_TD7; migration 0159 forms_td7): brand kit from fixed choices (colour, background, font, workspace logo), close date, answer limit with an atomic last place, closed message, form password (hashed, 10 tries per 15 minutes per address then 429), save and finish later with a signed 7 day link, cookie free views and completion with drop off per question, import from pasted lines or CSV, AI draft through the workspace AI routing (own key or built in AI behind the TD1 switch, never billed). Works with the TD2 renderer; file and signature uploads answer 410 on a closed form and 401 on a locked form before any bytes are read. No payment field. Page Content-Security-Policy unchanged.

## TD6 One inbox (2026-11-02)

- One inbox at /app/one-inbox (flag INBOX_TD6; migration 0157 adds inbox_lane_rules_td6, inbox_item_state_td6 and an agent runs index): notifications, recent Inbox mail from mailboxes the person can read, assistant replies and mentions of tasks assigned to the person (read through the References check) in one list, sorted Important and Noise by rules; moves are remembered per sender or source; done, snooze, read, bulk and keyboard keys. No AI and no provider call; ids and state only are stored.

## TD5 Universal mentions and references (2026-11-02)

- Typing @ in chat, task description and comments, doc comments and contact notes offers people and records (tasks, projects, docs, contacts, deals, meetings, forms, invoices) the reader can see, keyboard first (flag MENTIONS_TD5; migration 0156 record_refs, no titles or text stored).
- References panel (Mentioned in and Mentions) on task, doc, contact, deal, meeting, form and invoice; chat chips resolve per reader, so people without access see Restricted item; deleted targets show Deleted item; edits remove stale links; other workspaces 404, flag off 404.

## TD4 Time to invoice (2026-11-02)

- Invoices and quotes has a Bill time tab (owners and admins, flag BILL_TD4): unbilled billable time by person and task at the most specific rate, rounding per entry stated on each line, Create draft invoice makes a draft in the existing invoices with integer cents; billed entries are locked to the invoice by a conditional update so two runs can never bill the same time, and deleting the draft or voiding the invoice releases them (migration 0155).
- Home has a Time to bill card for managers (unbilled hours and value per client); billed entries refuse edit and delete; past runs list with a CSV export that neutralises formula cells; members 403, other workspaces 404, flag off 404.

## MH1 App to web sign in handoff (2026-11-02)

- POST /api/auth/mobile/web-link (the app's signed in session) answers a one time code {code, expires_in: 60}: 256 random bits, only its SHA-256 stored (verifications table), bound to the person and workspace (flag MOBILE_WEB_LINK; off answers 404; no migration)
- GET /auth/mobile/web?code=..&next=/app/.. burns the code on the first attempt, sets the normal web session for the same workspace (keeping the source session's age and sign in method) and redirects to a checked /app path; anything else lands on /login or /app. No referrer, no store, the strictest page policy, rate limited, and the code is scrubbed from error reports

## R121 Layout P2 navigation (2026-11-02)

- One menu model (src/shared/nav-menu.ts) drives the desktop rail, the phone More sheet and GET /api/nav/menu for the mobile app (flag NAV_P2_R121; off keeps the P1 navigation unchanged; no migration).
- Contacts is its own rail section (People, Deals); Mailboxes, Domains and Deliverability move to Settings > Mail setup next to Routing (old addresses redirect, client side and with a 302 from the server, ids, query and hash kept); Files joins Docs; Chat moves up next to Mail.
- Phone: tabs Home, Mail, Chat, a fourth tab each person picks (Tasks, Social, Calendar or Docs), More; More shows every section as a tile with the rail's count, then New social post and Settings.
- View > Customise menu hides rail sections per person (Home and Settings stay) and resets to default. What's new: "A tidier menu" (cap 14: the booking plus entry now lives only here).

## R124 Blog with newsletter (2026-11-02)

- Docs > Sites > Blog (flag BLOG_R124, needs SITES_R123; migration 0148: site_blogs, blog_posts, blog_authors, blog_images). Post bodies are ordinary docs under a "Blog posts" root doc, written in the Docs editor with co editing; publishing snapshots the rendered doc.
- Posts have an address, excerpt, cover, up to 10 tags and an author, and are draft, scheduled or published. Publish now, schedule (browser local time sent as an exact moment), update the live copy, unpublish or delete (the doc stays in Docs).
- Public pages at /site/<slug>/blog: index with pager, post, tag and author pages, each with title, description and Open Graph tags; RSS 2.0 at /blog/rss.xml; blog URLs in the site sitemap; a Blog item in the site menu once a post is live. Only https images and doc images on the blog allow list show publicly.
- Subscribe box with double opt in into one Campaigns audience list per blog (rate limited, shield checked); confirmation records the blog as the consent source.
- "Email this post to subscribers": opt in per post, admins only, sent once through Campaigns as a newsletter to confirmed subscribers with sender details and unsubscribe; scheduled posts schedule the email; unpublish cancels a scheduled email. Admins see subscribers (counts, search, remove, CSV export).
- Author profiles (name, bio, photo) with public author pages; Create > Blog post and Ctrl K entries. Guests, portal users and other workspaces cannot edit; subscriber emails are never logged.

## R123 Sites (2026-11-01)

- Docs > Sites (flag SITES_R123, migration 0143): one simple website per workspace at /site/<slug>, pages at /site/<slug>/<page>. Docs shows Sites once a site exists; before that it is reached from Create > Site page and Ctrl K.
- Block page builder: hero, heading, text, image, button, quote, features, divider, form (embedded link to Forms) and booking (link to a booking page). Live preview in a sandboxed frame uses the same renderer as the public page, with desktop and phone widths. Ctrl S saves, Ctrl Enter publishes.
- Drafts, versions (saved and published, restore into the draft), publish now or at a set time (promoted on read), take offline. Every published page has a title, description, og:title and og:image (falls back to the workspace logo).
- Safe blocks only: text is escaped with a small inline format, links must be https, mailto, tel or a site path, and button colours keep AA contrast.
- Comments: always moderated, the booking spam shield (proof of work, fill time, honeypot), 5 per sender per day by a hashed key. Comments tab to approve, reject or delete.
- Stats: views per page, day, source and device only. No addresses, cookies or visitor ids.

## R105 Invoices and quotes (2026-11-01)

- Contacts > Invoices: quotes, tax invoices, credit notes (adjustment notes), bills and suppliers, an items catalogue, and reports (aged receivables, GST for BAS on accrual or cash basis). Flag INVOICES_ENABLED.
- Australian rules: integer cents, GST 10 percent per line with GST free lines, prices including or excluding GST per workspace, the words Tax invoice, supplier name and ABN (checksum), buyer name or ABN from A$1,000, numbers given only at issue and never reused (void, not delete).
- Send by email with a view link; the logged out page shows that one document, the PDF, bank details (BSB and account) and Accept or Decline on quotes. Payments are recorded by hand; nothing is charged. Reminders before and after the due date and repeating invoices run on the cron. On the test site invoice mail only goes to the QA mailbox.
## R92 Booking plus: resources, time polls, free events with QR tickets, spam shield (2026-11-01)
### Added
- Work > Booking has Resources, Time polls and Events tabs, behind BOOKING_PLUS.
- Resources: rooms, desks, vehicles and equipment on a day grid (cards on phones) with open days and hours, shortest and longest booking, a weekly quota per person, approval by admins, and check in from a printed QR code that releases bookings nobody checked in to.
- Time polls: propose times, share a link, people answer Yes, If need be or No without an account, and picking the best time makes the meeting and emails everyone who left an email.
- Free events: a public event page with free tickets, a capacity and a waitlist, a QR ticket by email and on its own page, check in at the door by camera or typed code, and an attendee CSV. Paid tickets are not part of this round.
- Spam shield for public forms (shared module for later forms): a signed challenge with a small proof of work solved in the browser, a hidden field, a minimum fill time and one time use, beside per IP limits. No captcha. While Booking plus is on, the public booking page uses it too.
### Notes
- Migration 0132 (additive). "Fix a PDF, slides, image links and everyday utilities" left What's new to keep it at 14.
- A refused shield check is retried once in the browser with a fresh challenge, and otherwise says why and how to send again.
## R113 Office files in the browser (2026-11-01)
### Added
- Files: Open in editor for Word (.docx), Excel (.xlsx) and CSV files, and View slides for PowerPoint (.pptx), from the row menu and the preview panel (flag OFFICE_EDIT_R113).
- Word editor: headings, bold, italic, underline, strike, links, bullet and numbered lists, quotes, code, tables and pictures, read in the browser and saved back to .docx. A list of what is not kept (headers, comments, tracked changes, colours) shows when it applies.
- Sheet editor: all sheets as tabs, a formula bar and SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, ROUND, ABS, AND, OR, NOT and CONCAT with cell refs, ranges and other sheet refs; saved back to .xlsx (formulas kept) or .csv (values). Up to 5,000 rows, 100 columns and 200,000 cells; bigger files open view only. Phones view only.
- Slides: drawn by the Tools engine and shown with a slide strip; a text outline when slides cannot be drawn.
- Every save is a new Files version with the note "Saved in the editor"; a save that started from an older version asks first (409 version_conflict). Viewers read only; guests and the client portal get nothing, as in Files.
- No new dependencies (fflate, fast-xml-parser, papaparse, tiptap and pdf.js were already in use). No migration.

## R114 Webinar mode for meetings (2026-11-01)
### Added
- Webinar mode on any meeting (flag `WEBINAR_R114`, migration 0137): hosts and panelists on stage, attendees watch only.
- Public registration page `/w/<slug>` with a honeypot and form timer bot check, per address limit, duplicate email resend, closed, ended and full states; the personal join link is stored hashed.
- Attendee page `/w/a/<token>`: stage, questions with upvotes, polls and word clouds on the R96 tables, chat when the host allows it.
- Host page `/app/meetings/<id>/webinar`: hide, answer or mark questions answered, chat setting (everyone, hosts only, off) and hide a message, launch and close polls, promote and demote panelists, registrations and report with CSV, replay from a finished recording (transcript and summary; no video is kept).
- Real cap: 100 people per room on the video free plan, and on the free plan as many attendees as the call minutes left allow ("Up to N attendees on your plan").
- "2026-11-01-tasks-plus" left the What's new list to keep it at 14 and moved to the public earlier list.

## R108 Contracts: templates and guided interviews (2026-11-01)
### Added
- Tools, Templates, Contracts: plain words templates for a service agreement, an NDA (mutual or one way), a contractor agreement, quote terms and a privacy notice, each with the "This is a template, not legal advice" note on the template and the generated document.
- Guided interview: branching questions (only what matters for your answers), checks for required answers, dates, money, email and ABN, a live preview, then a Doc (normal sharing), a PDF, a Word file or Send to sign (e-sign page).
- Renewal and end date reminders as tasks; a clause library with versions (admins edit, retire and bring back; contracts record the versions used) and workspace versions of templates. Docs, Templates links to it. Flag CONTRACTS_R108. Migration 0130.


## R110 Ask your workspace (2026-11-01)
### Added
- Tools, Ask your workspace (flag `ASK_R110`, migration 0131): ask a question across mail, docs, tasks, contacts and files. Answers use only items the asker can open, checked at question time (access removed later hides them too), list their sources and carry a note that AI answers can be wrong. Prompt library, private searchable history, save an answer to a doc, and change cards that apply nothing until Apply is clicked. Ctrl K offers "Ask AI" for a typed question. Guests get no Ask.
- Save to a doc asks first when the answer used items some members cannot open (your own mail, a private channel, a private note): a saved doc is open to the whole workspace, so nothing is shared without that click.
- Free tier AI only: a per workspace daily cap and an account wide daily cap, counted before each call, with a calm "Daily limit reached" state; the client workspace excluded from Ask stays excluded.
### Fixed
- A long search (about 48 characters or more) in Contacts answered 500 on production: D1 refuses a LIKE pattern over 50 bytes. Contacts, Companies, Docs and Tasks lists, global search, the new search and Ask history now match with instr, with no length limit, and % and _ are plain characters.
- Search: a guest's results open the guest view of the item; a bad filter gets a plain message.
- Search: while results load, the command menu list no longer holds a progress bar (axe aria-required-children at 1280); the list says it is busy instead.
- Tests: the calendar sync e2e builds its events in the Sydney month the page shows, not the UTC month.
## R101 Files plus: drive and brand library (2026-11-01)
### Added
- Files: Team files, My files, Shared with me, Starred, Recent and Trash; folders with breadcrumbs, drag and drop upload and move, Move to, star, rename.
- Previews in the page for images, PDF pages, video, audio and text; other types show a file card with Open.
- Versions: every upload of the same file keeps up to 20 versions, each restorable; Trash keeps deleted items 30 days with restore and delete forever.
- Bulk select: move, trash, star and download as a zip made in the browser (only files the person can open).
- My files are private; share a file or folder with a teammate as view or edit. Brand library with tags: everyone views and uses, only admins change it; download an image at a chosen width.
- Behind FILES_PLUS_R101 (migration 0129). File bytes in their own D1 database (FILES_DB), 20 MB per file, 200 MB per workspace. Project guests and client portal visitors get no drive.

## R103 Docs plus: link library, saved pages, doc comments, spell check (2026-11-01)
### Added
- Docs, Link library: keep the team's links with tags, search and a tag filter; remove asks first and keeps any saved doc.
- Save a page: a public web page becomes a clean doc in Web clips (or a page you pick) with a link back to the source, and downloads as a PDF. Private and internal addresses are refused, with a size and time limit.
- Doc comments: a Comments panel on every doc for the team and project guests, with mentions and notifications; a Comments switch per shared link lets visitors comment, and each visitor comment waits for review by an owner, an admin or the doc's creator.
- Spelling: a Check spelling button in docs and mail compose (20 languages, browser spell check with a language choice).
### Notes
- Behind DOCS_PLUS_R103 (on in staging). Migration 0125 adds link_library, doc_comments and share_links.comments.
## R111 Mail archive and retention (2026-11-01)
- Settings > Mail > Archive and retention (admins): a workspace retention policy (keep N years, or forever) with a dry run count before it can be turned on and a 7 day grace before anything is removed; legal holds per person or mailbox that always win; archive search and case export as an mbox ZIP; every pass, hold, search and export is in the audit log, which gains filters on Activity. Members see a read only notice; guests nothing. Behind MAIL_ARCHIVE_R111; no policy is on anywhere until an admin turns one on.
- Undo send survives a closed tab: if the tab closes during the hold, the message is handed to the server with a request that outlives the page, under the same Idempotency-Key, so it is never lost and never sent twice; anything that could not leave comes back in Compose on the next visit. Send later is keyed the same way.
- Command menu finds Slides; Forest hover contrast on tool buttons; analytics events are flushed when the page is hidden.
- What's new: "Archive and retention for mail" took the place of "Whiteboards, diagrams, mind maps and slides in Docs".

## R118 Social P2b: inbox, account health, analytics (2026-10-31)
### Added
- Social, Inbox: comments, messages and mentions from Facebook Pages, Instagram and Reddit in one list; assign, mark done, internal notes, saved replies, link to a contact, make a task; the 24 hour reply window on Meta messages; a bell alert for new items.
- Social, Analytics: reach, engagement and clicks per post and per account (Facebook, Instagram, Pinterest, Threads) and best times to post.
- Account health: broken accounts pinned with Sign in again and Reconnect, a bell alert when an account breaks, warnings on planned posts; each account lists what it can do (LinkedIn says posting only).
- Staging only test network (SOCIAL_TEST_NETWORK, refused on multies.si) for end to end checks. Flag SOCIAL_P2B. Migration 0122.
## [Unreleased] (rounds 11 to 15)

### Round 109 (1 Nov 2026)

- Mail merge, newsletters and journeys in Tools > Merge, behind merge_plus_r109: lists with a consent record per person (express, or inferred only where the list allows it), signup page with double opt in, block editor with merge fields, fallbacks and the workspace brand, test send, send now or schedule, private open and click counts, bounces and complaints, and journeys (a simple step list on the jobs queue with waits in the list's time zone and "only if they didn't open").
- Spam Act: sender name and address in every email, List-Unsubscribe and List-Unsubscribe-Post headers plus a footer link, unsubscribes honoured at once across every list and never re-added by import, sending within the workspace's daily mail limit. Staging bulk mail goes only to the QA mailbox and fails closed. The public unsubscribe and signup pages have their own tight policy so their forms post.

### Round 115 (1 Nov 2026)

- Maps (flag MAPS_R115): an address card on contacts, companies and the booking page with search as you type, a map pin (free OpenFreeMap tiles) and directions in Apple Maps or Google Maps; an address can also be saved as typed.
- Contacts > Visits: pick who you are visiting, put them in the shortest straight line order (nearest neighbour then 2 opt), and open the route in a maps app, in parts of 10 places for long days. Command menu: Plan visits.
- Address lookups run on the server through free keyless services (Photon for suggestions, Nominatim for a full search) at most once a second each, cached for 30 days under a hash of the query, with 200 live lookups per workspace a day. Migration 0123 (places, geo_cache, geo_usage, geo_throttle), additive.
- The public booking page shows the meeting place with directions when the host set one. What's new: the "Convert any file" entry moved out to keep the list at 14 (it stays here).
- Calendar and contacts sync fixes (from the R99 review): after making an app password the shown once password field takes focus, and closing the dialog returns focus to Create app password; Home and End move to the first and last setup guide tab; the synced bookings calendar reads exactly the bookings the app shows (your own booking page).
- Bookings on /app/scheduling: the list now loads every upcoming booking, 50 at a time with Load more, instead of stopping at the first 100.


### Round 99 (1 Nov 2026)

- Calendar and contacts sync: Multies serves CalDAV and CardDAV at /dav (with /.well-known/caldav and /.well-known/carddav), so iPhone, Android, Mac and Outlook show and edit your meetings, task due dates (all day), bookings (read only) and workspace contacts. Sync tokens send only what changed; a stale ETag answers 412; Multies keeps the fields it owns (invitees, video link, series rules, task status, contact email).
- Per person app passwords in Settings, Calendar, Sync with your phone: shown once, stored hashed, named, last used shown, revoked at once, audit events on create and revoke. The account password never opens /dav. Setup guides per device and an unsigned configuration profile for iPhone and Mac.
- Flag DAV_SYNC_R99 (staging on). Migration 0124 (dav_app_passwords, dav_sync_states, dav_names). scripts/dav-check.mjs is a scripted client check for staging.

### Hotfix contacts (1 Nov 2026)

- Contact pages and the CRM timeline answered 500 (shown as Contact not found) for addresses of 37 characters or more, because the database refuses LIKE patterns over 50 bytes; the address match now uses instr. A test emulates the limit.

### Round 94 (31 Oct 2026)

- CRM timeline: one paged timeline per contact and per company of email, logged notes, calls and meetings, meetings, bookings, form submissions, deal moves and tasks, with filters and a next step kept as a linked task.
- Companies can be added by hand and have their own page. Contacts can be imported from a CSV file (up to 5,000 rows, matched by email so nobody is added twice) and filtered into saved segments, private or shared with the team.
- Deals have a chance to win (a stage default or set by hand), a won or lost reason, the date they closed, and a weighted forecast above the board. Behind CRM_TIMELINE.
### Round 97 (1 Nov 2026)

- Added: Tasks plus (flag `TASKS_PLUS_R95`, off unless on; migration 0126). My Day on My Work: a today list with due suggestions, a day column to drag tasks onto (15 minute snap, no overlaps, resize, keyboard Earlier/Later/Longer/Shorter), plan tomorrow with undo. Smart repeat: every weekday, nth weekday of the month (5th falls back to last), count from due or from done, time zone kept, rotation between members (people who left are skipped), next dates preview. Time: tags and billable on entries, tag filter, day view, CSV export (formula safe), weekly submit, withdraw, approve and return (approval admin only, an approved or submitted week locks a member's entries, guests get no timesheets), idle prompt that can drop away time. Mind map view per project: drag to re parent with undo, cycles refused (server 422 `parent_cycle`), keyboard move, phone outline. What's new: the oldest entry after What's new itself made room (still listed below).
- Added: notification centre (flag `NOTIFICATION_CENTRE`, on unless set to off; off answers the old settings shape; migration 0121). Mail as a third channel per category (off by default), mail as it happens or one daily or weekly digest at a time and weekday in the member's own time zone, quiet hours (days, own zone, optional mentions and approvals through), pause for 1 hour, 3 hours or until tomorrow morning, and a New mail alert switch. Settings, Notifications gains a Mail column and three cards; Notifications gains a Pause menu and a status line with Resume.
- Changed: every phone and browser alert passes one check (`alertRecipients`, `decide`): new mail alerts and bulk watcher alerts now respect pause, quiet hours and the person's switches. `GET/PUT /api/notifications/settings` add `delivery` and a `mail` field per category (add only).
- Added: digest pass on the 15 minute cron reads only due rows (index on `digest_due_at`, 50 a run); instant mail goes through the job queue (`notify.mail`).

### Round 117 (31 Oct 2026)

- Added: Social composer v2 on New post (flag `SOCIAL_P2`, on unless set to off; off keeps the old composer; migration 0109). Pick a format first (text, image, carousel, video, story or reel), give each network its own text (it follows the main text until edited), counters per network limit, a live preview per network (side panel at 1280, a sheet on phones) and checks before send that list e