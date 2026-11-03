/**
 * W1: the product areas the public site describes, one page each at /features/<slug>. Pure data, shared by the pages,
 * the page titles (seo-meta.ts), known routes and the sitemap test. Only what is live on multies.si goes here.
 * Plain words, sentence case, no dashes, no vendor or competitor names.
 */
export interface AreaPoint { t: string; b: string }
export interface MarketingArea {
  slug: string;
  /** Short name for the grid, nav and footer. */
  name: string;
  /** One line for the grid on the home page and /features. */
  line: string;
  /** Page title and description (search results and shared link previews). */
  title: string;
  description: string;
  headline: string;
  intro: string;
  points: AreaPoint[];
  /** Where to find it once signed in. */
  where: string;
  shotAlt: string;
}

export const AREAS: readonly MarketingArea[] = [
  {
    slug: "mail", name: "Mail", line: "Mailboxes and aliases on your own domain, a shared team inbox and live DNS checks.",
    title: "Email on your own domain | Multies",
    description: "Mailboxes and aliases on the domain you own, a shared team inbox with helpdesk mode, live DNS checks, newsletters and mail archive. Free to start.",
    headline: "Email on the domain you already own.",
    intro: "Give everyone a real mailbox at your business name, share sales@ and support@ as a team, and see every DNS record checked live so your mail lands in inboxes.",
    points: [
      { t: "Mailboxes and aliases", b: "Real inboxes for people and aliases for roles. Keep your domain where it is registered: you add a few records and we check each one for you." },
      { t: "A shared team inbox", b: "Assign threads, leave private notes and see who is replying. Helpdesk mode turns the shared inbox into tickets, with a chat box for your website." },
      { t: "Signed properly", b: "Every domain gets its own DKIM key, live DNS checks, bounce handling and DMARC reports, so your mail reaches inboxes rather than spam." },
      { t: "Rules, labels and snooze", b: "Sort mail with rules, snooze what can wait, and find any message with search that forgives typos." },
      { t: "Newsletters from your own address", b: "Send newsletters and welcome emails to your contacts from your own domain, with sign up forms and unsubscribes handled." },
      { t: "Archive and secure sending", b: "Admins can keep mail for set years, place a legal hold and search the whole workspace. Send a file that expires or opens only once." },
    ],
    where: "Mail and Inbox in the left menu.",
    shotAlt: "The Multies mail screen with a list of threads and an open message.",
  },
  {
    slug: "tasks", name: "Tasks and projects", line: "Boards, lists, calendar and timeline, with My Day, time tracking and automations.",
    title: "Tasks and projects | Multies",
    description: "Turn any email into a task. Boards, lists, calendar and timeline, custom fields, My Day time blocking, time tracking, goals, automations and dashboards.",
    headline: "Turn email into work, without another app.",
    intro: "Plan projects on boards, lists, a calendar or a timeline. One click turns a thread into a task with the message linked, so nothing gets lost between mail and work.",
    points: [
      { t: "Tasks from email", b: "Make a task from any thread with its subject and latest message. Assign it to a person or an agent, set a due date and priority, add subtasks." },
      { t: "Boards, lists and timelines", b: "Drag cards across a board, sort a list, plan on a calendar or a timeline with dependencies. Each project has its own statuses." },
      { t: "My Day and time tracking", b: "Drag today's tasks onto your day to block out time, start a timer on any task, and see timesheets per person and project." },
      { t: "Custom fields, goals and templates", b: "Add fields like Budget or Stage, then filter and group by them. Set goals that roll up, and start projects from templates." },
      { t: "Automations", b: "Build flows that react to new mail, tasks or forms, with a run log, watchers and outgoing webhooks." },
      { t: "Dashboards", b: "Charts and numbers on your work, shared by link, emailed on a schedule, with alerts when a number moves." },
    ],
    where: "Tasks in the left menu.",
    shotAlt: "A Multies project board with task cards in columns.",
  },
  {
    slug: "chat", name: "Chat", line: "Channels, direct messages and threads beside your mail and tasks.",
    title: "Team chat | Multies",
    description: "Channels, direct messages and threads with mentions and files, topics, announcements and votes, beside your mail and tasks.",
    headline: "Team chat beside your mail and tasks.",
    intro: "Talk in channels and direct messages without leaving the place your mail and work already live. Turn any message into a task in one click.",
    points: [
      { t: "Channels, messages and threads", b: "Public and private channels, direct messages and threads, with mentions, files and task links that open in one click." },
      { t: "Topics, announcements and votes", b: "Keep long channels tidy with topics, post announcements people can't miss, and run a quick vote." },
      { t: "Messages become tasks", b: "Make a task from any message, with a link back to the conversation." },
      { t: "Notifications your way", b: "Choose per category what reaches you, get a daily or weekly digest, and set quiet hours." },
      { t: "Mentions and one inbox", b: "Mention a task, doc, contact or person with @. Notifications, mail and assistant replies meet in one inbox, sorted into Important and Noise by your rules." },
    ],
    where: "Chat in the left menu.",
    shotAlt: "A Multies chat channel with messages and a thread.",
  },
  {
    slug: "docs", name: "Docs", line: "Docs, diagrams, whiteboards, a help center and answers from your workspace.",
    title: "Docs, whiteboards and a help center | Multies",
    description: "Write docs together, draw diagrams and whiteboards, present, publish a public help center, use contract templates and ask questions across your workspace.",
    headline: "Write it down beside the work.",
    intro: "Briefs, meeting notes and plans live next to the projects, tasks and threads they belong to, and your team edits them together live.",
    points: [
      { t: "Docs that link to the work", b: "Write together live, then link a doc to a project, a task, a thread or a contact. Comments and spell check built in." },
      { t: "Diagrams and whiteboards", b: "Draw diagrams and mind maps, sketch on a whiteboard, and present any doc full screen." },
      { t: "A public help center", b: "Publish a knowledge base and questions and answers for your customers on the web." },
      { t: "Contract templates", b: "Plain words templates with a guided interview, then send the contract to sign." },
      { t: "Ask your workspace", b: "Ask a question and get an answer that cites only the mail, docs and tasks you can open." },
      { t: "Link library and web clipper", b: "Save links and public pages for your team in one library." },
    ],
    where: "Docs in the left menu.",
    shotAlt: "A Multies doc open in the editor.",
  },
  {
    slug: "files", name: "Files", line: "A shared drive with folders, previews, a brand library and safe sharing.",
    title: "Files and secure sharing | Multies",
    description: "A shared drive with folders, versions and previews, office files you edit in the browser, a brand library, file request links, expiring shares and PDF tools.",
    headline: "Every file in one place, shared safely.",
    intro: "Keep the team's files in folders with previews and versions, and share them with people outside without losing track of who opened what.",
    points: [
      { t: "Folders, versions and previews", b: "A shared drive for the team, with previews of documents, images and PDFs, and earlier versions kept." },
      { t: "A brand library", b: "Logos and brand files in one place, so everyone uses the right ones." },
      { t: "Secure sharing", b: "Ask clients for files with a request link, share with links that expire and a view log, or send a secret that opens once." },
      { t: "Office files in the browser", b: "Edit Word files and Excel sheets with working formulas right in Files, save each change as a version, and view slides without leaving the browser." },
      { t: "PDF tools", b: "Convert office files, compress and edit PDFs, read text from scans, and add QR codes." },
    ],
    where: "Files in the left menu.",
    shotAlt: "The Multies files drive with folders and file previews.",
  },
  {
    slug: "meetings", name: "Meetings", line: "Video meetings from any thread, task or contact, with recordings.",
    title: "Video meetings | Multies",
    description: "Start a video meeting from an email, a task or a contact. Guests join in the browser, invites go from your own address, and meetings can be recorded.",
    headline: "Meet without leaving the conversation.",
    intro: "Start a video meeting from the email, task or contact it is about. Guests join from a link in their browser, with nothing to install.",
    points: [
      { t: "Start from a thread", b: "Start or schedule a meeting from an email, a task or a contact, and the calendar invite goes out from your own address." },
      { t: "Guests join in the browser", b: "People outside your team join from a link, with no account and nothing to install." },
      { t: "Recordings and notes", b: "Record a call for a transcript and summary, kept with the task or contact it belongs to." },
      { t: "Action items from meetings", b: "Get suggested action items with an owner and a due date, then accept, edit or discard each one before it becomes a task. Follow up emails stay drafts until you send them." },
      { t: "On your phone calendar", b: "Meetings, task due dates and bookings sync to the calendar on your phone and computer." },
    ],
    where: "Meetings in the left menu.",
    shotAlt: "The Multies meetings list with upcoming meetings.",
  },
  {
    slug: "booking", name: "Booking", line: "Booking pages, rooms and desks, time polls and events with tickets.",
    title: "Booking pages, rooms and events | Multies",
    description: "Booking pages for clients, rooms, desks, vehicles and equipment with rules, time polls guests answer without an account, and free events with tickets and a waitlist.",
    headline: "Let people book you, a room or a seat.",
    intro: "Share a booking page, book the team's rooms and equipment, find a time that suits everyone, and run free events with tickets.",
    points: [
      { t: "Booking pages", b: "Clients pick a time that suits you, without an account. Add a meeting place with directions, or a video link." },
      { t: "Rooms, desks and equipment", b: "Book rooms, desks, vehicles and equipment, with rules for how long and how far ahead people can book." },
      { t: "Time polls", b: "Offer a few times, let guests vote without an account, then pick the winner and send the invite." },
      { t: "Events with tickets", b: "Publish a free event. People get a ticket with a code by email, join a waitlist when it is full, and move up when a place opens." },
    ],
    where: "Work, then Booking.",
    shotAlt: "The Multies booking page with rooms and resources.",
  },
  {
    slug: "contacts", name: "Contacts and CRM", line: "Contacts that build themselves, a deal pipeline, timelines and client portals.",
    title: "Contacts and CRM | Multies",
    description: "Everyone you email becomes a contact with their company and a timeline. Track deals on a pipeline, plan visits on a map, and share a portal with each client.",
    headline: "Know every client, without data entry.",
    intro: "Contacts and companies build themselves from your mail, and each one has a timeline of every thread, task, meeting and note.",
    points: [
      { t: "Contacts that build themselves", b: "Everyone you email becomes a contact with their company. Import the rest from any address book." },
      { t: "One timeline per client", b: "Every thread, task, meeting and note in one stream, with private notes and filters." },
      { t: "A deal pipeline", b: "Track deals on a board in Australian dollars, from first email to won." },
      { t: "Maps and visits", b: "Addresses with suggestions, a map and directions, and a route for a day of visits." },
      { t: "Client portals", b: "Share a private page with each client for their tasks, files and messages." },
      { t: "Next steps from your mail", b: "Contacts suggests next steps it finds in your mail, like a call on Thursday. Nothing changes until you save it, and you can edit, discard or undo." },
    ],
    where: "Contacts in the left menu.",
    shotAlt: "A Multies contact with company details and an activity timeline.",
  },
  {
    slug: "invoices", name: "Invoices and quotes", line: "Quotes and Australian tax invoices with GST, links to pay and reports.",
    title: "Invoices and quotes | Multies",
    description: "Make quotes and Australian tax invoices with GST worked out, send a link with a PDF and how to pay, record part payments, and see aged and GST reports.",
    headline: "Quote it, invoice it, get paid.",
    intro: "Add your business name and ABN once, then make quotes and tax invoices from the same place you talk to the client.",
    points: [
      { t: "Australian tax invoices", b: "GST worked out for you, your ABN on every invoice, and numbering that never skips." },
      { t: "Quotes that become invoices", b: "Send a quote, and once the client accepts it, turn it into an invoice in one click." },
      { t: "Time to invoice", b: "Turn tracked time into a draft invoice with rates per project and person. Billed time is locked so it is never billed twice." },
      { t: "A link for your customer", b: "Customers open the invoice from a link, download a PDF and see how to pay." },
      { t: "Payments and reports", b: "Record part payments, see what is overdue in an aged report, and get your GST totals." },
      { t: "The right people decide", b: "Members can draft. Only admins can issue or send." },
    ],
    where: "Contacts, then Invoices and quotes.",
    shotAlt: "A Multies invoice with line items and GST.",
  },
  {
    slug: "sign", name: "Sign and forms", line: "Send documents to sign and collect answers with forms.",
    title: "E-signing and forms | Multies",
    description: "Send documents to sign with an email code, keep a sealed signing record, use templates, and turn form answers from your website into tasks.",
    headline: "Get it signed, get it answered.",
    intro: "Send a contract or form to sign, and collect enquiries from your website straight into your work.",
    points: [
      { t: "Signing with an email code", b: "Signers confirm a code sent to their email before they sign." },
      { t: "A sealed signing record", b: "Every signed document comes with a record of who signed and when, and a page anyone can use to check it." },
      { t: "Templates and lists", b: "Save documents as templates and send one to a whole list of people." },
      { t: "Forms that do more", b: "File uploads, signatures, pages with progress and show or hide logic, plus your brand, a close date, an answer limit, a password and save and resume." },
      { t: "Forms that make tasks", b: "Public forms turn website enquiries into tasks for the right person, with file uploads, signatures, pages with a progress bar and questions that show or hide based on earlier answers." },
    ],
    where: "Docs for signing, and Forms under Work.",
    shotAlt: "The Multies forms page.",
  },
  {
    slug: "social", name: "Social", line: "Plan, approve and post to your social accounts, and answer comments in one place.",
    title: "Social posts and inbox | Multies",
    description: "Plan posts on a calendar, get drafts approved, keep images in a media library, answer comments in one inbox and see how posts did.",
    headline: "Your social posts, planned and approved.",
    intro: "Write a post once, plan it on a calendar, get it approved and publish it to the accounts you connect.",
    points: [
      { t: "Planner and drafts", b: "Plan posts on a calendar, keep drafts, and ask a teammate to approve before anything goes out." },
      { t: "Media library", b: "Keep the images and videos you post in one place." },
      { t: "Social inbox", b: "Answer comments and messages from your connected accounts in one inbox." },
      { t: "How posts did", b: "See reach and engagement per post and per account, and spot an account that needs reconnecting." },
    ],
    where: "Social in the left menu.",
    shotAlt: "The Multies social planner calendar.",
  },
  {
    slug: "agents", name: "AI agents", line: "Inboxes for AI agents, with a person approving what they send.",
    title: "AI agents with human approval | Multies",
    description: "Give each AI agent its own address on your domain. A person approves what agents send, with daily caps and an audit log. Connect any AI through MCP, free.",
    headline: "AI agents that help, with a person approving.",
    intro: "Agents get their own inboxes and tools in your workspace. By default, every message an agent writes waits for a person to approve it.",
    points: [
      { t: "Inboxes for agents", b: "Give an agent its own address with one API call. It reads mail as clean JSON and replies in the thread." },
      { t: "You approve what agents send", b: "New agents need a person to approve every message. Set daily caps and allowed recipients, and see every action in the audit log." },
      { t: "Bring your own AI", b: "Connect any AI app or agent through MCP, free. The built in MCP server reads, searches and replies, scoped to one key." },
      { t: "Built in AI or your own key", b: "Summaries, drafted replies and sorting with free built in AI, a daily allowance that never bills, or with your own model key, billed by your provider. Admins can turn AI off." },
      { t: "Team AI", b: "A shared assistant with memory and instructions your team can see and edit, routines that write drafts, and answers in chat channels." },
      { t: "API and webhooks", b: "A REST API with scoped keys and signed webhooks for mail, tasks, docs and agents." },
    ],
    where: "Agents and Approvals in the left menu.",
    shotAlt: "The Multies approvals screen with a message an agent wrote, waiting for a person.",
  },
];

export const AREA_SLUGS: readonly string[] = AREAS.map((a) => a.slug);
export const areaBySlug = (slug: string | undefined): MarketingArea | undefined => AREAS.find((a) => a.slug === slug);
