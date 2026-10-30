import { RESIDENCY_ANSWER, WHERE_DATA_LIVES } from "./residency";

/**
 * Legal documents for Multies: privacy policy, terms of service, acceptable use policy and
 * data processing agreement. Final text, effective 30 October 2026 (the owner approved review of 30 October 2026 applied), issued by Fintex Australia
 * Pty Ltd and governed by the laws of New South Wales, Australia. Keep every statement true to
 * how Multies works; when the product changes (a new provider, a new plan rule), change the text
 * here and update LEGAL_UPDATED.
 */
export const LEGAL_ENTITY = {
  name: "Fintex Australia Pty Ltd",
  abn: "60 688 406 108",
  acn: "688 406 108",
  address: "New South Wales, Australia",
  // Every public contact uses the company address until the multies.si mailboxes are routed into a read inbox.
  privacyEmail: "contact@fintex.au",
  abuseEmail: "contact@fintex.au",
  supportEmail: "contact@fintex.au",
  contactEmail: "contact@fintex.au",
  website: "https://fintex.au",
};

/**
 * The standard legal line for page footers and the trust page, word for word from the company
 * runbook. Render it with the company name linked to LEGAL_ENTITY.website (see LegalLine).
 */
export const LEGAL_LINE = {
  before: "Multies is provided by ",
  company: LEGAL_ENTITY.name,
  after: ` (ABN ${LEGAL_ENTITY.abn}), New South Wales, Australia. Contact: ${LEGAL_ENTITY.contactEmail}.`,
};
export const LEGAL_LINE_TEXT = LEGAL_LINE.before + LEGAL_LINE.company + LEGAL_LINE.after;

/** The date the current version of every legal document took effect. */
export const LEGAL_EFFECTIVE = "30 October 2026";
export const LEGAL_UPDATED = "30 October 2026";

export type Block = string | { list: string[] } | { table: string[][] };
export interface LegalSection { id: string; title: string; body: Block[] }
export interface LegalDoc { slug: string; title: string; summary: string; sections: LegalSection[] }

const E = LEGAL_ENTITY;

/**
 * The Privacy policy names providers by what they do (owner rule, 30 October 2026); the Data processing
 * agreement names each sub processor, because a business customer is entitled to know who they are.
 * Keep both tables, and SUBPROCESSORS in src/shared/trust.ts, saying the same thing.
 */
export const PROVIDER_CATEGORIES: string[][] = [
  ["Provider", "What they do for us", "Data", "Where"],
  ["Our hosting and database provider", "Hosting, database, live doc rooms, inbound mail routing, edge network and DDoS protection", "All service data", "Primary database in our hosting provider's Oceania region; edge network worldwide"],
  ["Our sign in provider", "Sign in and sign up", "Name, email address, sign in method, second factor enrolment", "Australia; accounts made before 25 October 2026 in the United States until moved"],
  ["Our outbound email provider", "Delivery of mail you send to addresses outside Multies", "Outbound messages and their recipients", "United States"],
  ["Our payments provider", "Payments and invoices for paid add ons", "Billing contact; card details are held by our payments provider, never by us", "Australia and United States"],
  ["Our error monitoring provider", "Error and performance monitoring", "Error reports with account ids; no message content", "United States"],
  ["Our video meetings provider", "Video meetings, only while a meeting is running", "Meeting audio and video, display names", "United States"],
  ["Our push notification provider", "Notifications to the Multies phone apps, only when push notifications are turned on", "Device push token and message ids; no message text", "United States"],
  ["Our document engine host", "Runs our document engine for Tools, only when you use a tool", "Files you run through Tools and their results, deleted within 1 hour", "Singapore"],
  ["A public DNS resolver", "Second resolver for domain checks when the first does not answer", "Domain names being checked; no personal information", "Worldwide"],
  ["Your chosen AI provider", "Only if your workspace adds its own API key: the assistant sends the thread you ask about to that provider, on your account with them", "The email thread you ask the assistant about", "Set by the provider you choose"],
];

/** The named sub processor list in the Data processing agreement (DPA items 83 and 84). */
export const SUBPROCESSORS: string[][] = [
  ["Sub processor", "What they do for us", "Data", "Where"],
  ["Cloudflare", "Hosting, database, live doc rooms, inbound mail routing, edge network and DDoS protection", "All service data", "Primary database in Cloudflare's Oceania region; edge network worldwide"],
  ["Auth0 (Okta)", "Sign in and sign up", "Name, email address, sign in method, second factor enrolment", "Australia; accounts made before 25 October 2026 in the United States until moved"],
  ["Resend", "Delivery of mail you send to addresses outside Multies", "Outbound messages and their recipients", "United States"],
  ["Stripe", "Payments and invoices for paid add ons", "Billing contact; card details are held by Stripe, never by us", "Australia and United States"],
  ["Sentry", "Error and performance monitoring", "Error reports with account ids; no message content", "United States"],
  ["LiveKit", "Video meetings, only while a meeting is running", "Meeting audio and video, display names", "United States"],
  ["Expo", "Push notifications to the Multies phone apps, only when push notifications are turned on", "Device push token and message ids; no message text", "United States"],
  ["Render", "Runs our document engine for Tools, only when you use a tool", "Files you run through Tools and their results, deleted within 1 hour", "Singapore"],
  ["Google Public DNS", "Second resolver for domain checks when the first does not answer", "Domain names being checked; no personal information", "Worldwide"],
  ["Your chosen AI provider", "Only if your workspace adds its own API key: the assistant sends the thread you ask about to that provider, on your account with them", "The email thread you ask the assistant about", "Set by the provider you choose"],
];

export const PRIVACY: LegalDoc = {
  slug: "privacy",
  title: "Privacy policy",
  summary: "What we collect, why, who we share it with, and how to see, export or delete it.",
  sections: [
    { id: "who", title: "Who we are", body: [
      `Multies is provided by ${E.name}, ABN ${E.abn}, ACN ${E.acn}, ${E.address} ("Fintex", "we", "us"). Multies is a workspace for email, tasks, chat, docs, calendar and meetings, on the web and in the Multies apps for iPhone and Android. This policy explains how we handle personal information under the Privacy Act 1988 (Cth) and the Australian Privacy Principles (APPs), and, for people in the European Economic Area or the United Kingdom, under the GDPR.`,
      `This policy takes effect on ${LEGAL_EFFECTIVE}. Questions or requests: ${E.privacyEmail}. We answer within 30 days, usually much sooner.`,
    ] },
    { id: "roles", title: "Our two roles", body: [
      "For your account details (name, email, sign in, billing) we decide how the data is used, so we are the controller.",
      "For the mail, tasks, messages, docs and files in your workspace, and the people you correspond with, your workspace decides, and we process them on your behalf as a processor. Our Data processing agreement sets out those terms.",
    ] },
    { id: "collect", title: "What we collect", body: [
      { list: [
        "Account: name, email address, sign in method, two factor settings and profile details you choose to add.",
        "Workspace: domains, mailboxes, aliases, members and roles, settings, API keys (stored hashed), webhook endpoints.",
        "Content: mail you send and receive with its attachments, folders and flags, delivery records (sender, recipient, time, result), and the tasks, comments, chat messages, docs, calendar events and files you create.",
        "Connected mailboxes: the address, the provider's server names, and the app password or sign in you give us, stored encrypted. We also keep a copy of the synced mail (see Connected mailboxes below).",
        "Free addresses: the name you choose on mail.multies.si, and, to stop abuse, a record of each claim with the network and a random device id from your browser.",
        "Billing: your add ons, invoices and the payments provider customer id. Card details go straight to our payments provider and never reach our servers.",
        "Security and usage: IP address, browser and device for each session, an audit log of important changes, and request logs kept for no more than 30 days.",
        "Support: what you send us when you contact us.",
      ] },
      "We do not buy personal information, and we do not collect sensitive information (as defined in the Privacy Act) on purpose. Mail you receive may contain it; we treat all content as confidential.",
    ] },
    { id: "connected", title: "Connected mailboxes", body: [
      "You can connect a mailbox you already have at another email provider or on your own mail server.",
      { list: [
        "Password: the app password (or sign in) you give us is encrypted before it is stored, is never shown again, never written to logs, and never shared. We use it only to sync that mailbox and to send mail from it when you ask us to. When you remove the connection, we delete it straight away.",
        "Synced mail: we copy that mailbox's messages (and their read, starred and folder state) into your workspace, so you can read, search and reply in Multies. That copy is stored and protected like all other mail in your workspace, and the original stays at your provider. Removing the connection deletes our copy; nothing is deleted at your provider.",
        "Sending: mail you send from a connected address goes out through that provider's own servers, so it never passes through our outbound email provider.",
        "Your provider's own privacy policy still applies to the mail it holds.",
      ] },
    ] },
    { id: "free-address", title: "Free addresses on mail.multies.si", body: [
      { list: [
        "Mail to your free address is received and stored by us in your workspace, and mail you send from it goes out through our outbound email provider (listed below).",
        "Automated checks score outbound messages for spam, and we limit how much each free address can send. No person reads your mail unless you ask us to in a support request, or the law requires it.",
        "To stop abuse we keep a record of each claim (the address, the time, the network and a random device id). Each person can claim one free address.",
        "If you delete the address or your account, its mail is deleted like any other mail, and the address is not given to anyone else.",
      ] },
    ] },
    { id: "use", title: "Why we use it", body: [
      { table: [
        ["Purpose", "GDPR lawful basis"],
        ["Run the service: store and deliver your mail and content, keep you signed in", "Performance of our contract with you"],
        ["Bill you for paid add ons and keep tax records", "Contract; legal obligation"],
        ["Keep accounts and the network safe: rate limits, lockout, spam and abuse checks on outbound mail", "Legitimate interests (security); legal obligation"],
        ["Fix errors and measure reliability", "Legitimate interests"],
        ["Service emails: verification, security alerts, receipts, usage alerts", "Contract"],
      ] },
      "We do not read your mail. Automated checks scan outbound messages for spam signals and inbound messages for spam and authentication results; no person reviews content unless you ask us to in a support request, or the law requires it.",
      "We do not sell personal information, show ads, or use your content to train models.",
    ] },
    { id: "share", title: "Who we share it with", body: [
      "Only the service providers below, under terms that require them to protect it, and only for the purposes above. The public DNS resolver sees only domain names being checked. Our Data processing agreement names each provider.",
      { table: PROVIDER_CATEGORIES },
      "We may also disclose information if Australian law requires it (for example a valid warrant), and we will tell you unless the law forbids it.",
    ] },
    // R60 (trust): the same facts as /trust, from src/shared/residency.ts, so the two never disagree.
    { id: "where", title: "Where your data lives", body: [
      RESIDENCY_ANSWER,
      { table: [["Data", "Where", "Notes"], ...WHERE_DATA_LIVES.map((r) => [r.data, r.where, r.detail])] },
    ] },
    { id: "overseas", title: "Overseas disclosure (APP 8)", body: [
      "Multies does not offer Australia only storage. Our primary database, which holds your workspace data including mail synced from connected mailboxes, is placed in our hosting provider's Oceania region, our app servers run in Sydney, and requests first reach the edge location nearest you. Our sign in provider holds accounts in Australia. Files you run through Tools are processed on our document engine in Singapore and deleted within 1 hour. Some providers listed above process data in the United States, and our encrypted backup copies are kept in the United States. Our Trust page (multies.si/trust) lists where each kind of data lives. We take reasonable steps, including contractual commitments and, for European data, Standard Contractual Clauses, so they handle it consistently with the APPs and the GDPR.",
    ] },
    { id: "cookies", title: "Cookies", body: [
      "We use only cookies that are strictly necessary: a session cookie that keeps you signed in and a short lived cookie that protects sign in. There are no advertising or analytics cookies. If we turn on visitor analytics, it is cookieless and stores nothing on your device. Error monitoring does not set cookies. We show a short notice about this once; closing it saves a small note in your browser's local storage so it stays closed.",
    ] },
    { id: "keep", title: "How long we keep it", body: [
      { list: [
        "Account and workspace data: while your account is open.",
        "Mail and content: until you or your workspace delete it.",
        "Connected mailbox passwords: until you remove the connection, then deleted straight away. Synced copies of its mail: until you remove the connection or delete them.",
        "Free address claim records: for the life of the account, so the one address per person limit holds.",
        "Files you run through Tools: each input file is deleted right after its job, and everything is deleted within 1 hour.",
        "After you delete your account or workspace: removed from the live database straight away, and from backups within 30 days. Every backup copy is encrypted, and copies older than 30 days are deleted.",
        "Request logs: no more than 30 days. Audit logs: for the life of the workspace. Invoices: 7 years, as Australian tax law requires.",
      ] },
    ] },
    { id: "security", title: "Security", body: [
      "Data is encrypted in transit (TLS) and at rest. Signing keys, secrets and connected mailbox passwords are encrypted again before they are stored; sign in has lockout and optional two factor authentication, and important changes are written to an audit log. To report a security problem, see /.well-known/security.txt or our Trust page.",
      "If a data breach is likely to cause serious harm, we will notify you and the Office of the Australian Information Commissioner (OAIC) under the Notifiable Data Breaches scheme, and, where the GDPR applies, the relevant authority within 72 hours.",
    ] },
    { id: "rights", title: "Your rights", body: [
      "You can, at any time and without charge:",
      { list: [
        "See and download your data: Settings, Account, Your data. Workspace owners can export everything, mail included, from Settings, General.",
        "Correct it: edit your profile, or ask us.",
        "Delete it: Settings, Account, Delete account, or the Delete account page on our website. A sole owner of a shared workspace transfers ownership first, so no one else loses their workspace.",
        "Object to or restrict processing, or ask for portability, by emailing us.",
      ] },
      `If you are unhappy with how we handled your information, contact ${E.privacyEmail} first. If we do not resolve it within 30 days you can complain to the OAIC (oaic.gov.au, 1300 363 992) or, in Europe, your local data protection authority.`,
    ] },
    { id: "changes", title: "Changes and contact", body: [
      "We will email account owners at least 30 days before a material change. The date at the top shows the version in force.",
      `${LEGAL_LINE_TEXT}`,
    ] },
  ],
};

export const TERMS: LegalDoc = {
  slug: "terms",
  title: "Terms of service",
  summary: "The agreement between you and Fintex Australia when you use Multies.",
  sections: [
    { id: "agreement", title: "The agreement", body: [
      `These terms are an agreement between ${E.name}, ABN ${E.abn}, ${E.address} ("Fintex", "we", "us") and the person or business that creates or uses a Multies account ("you"). They take effect on ${LEGAL_EFFECTIVE}.`,
      "By creating an account or using Multies you agree to these terms, to the Acceptable use policy, and, where we process personal information for you, to the Data processing agreement. Our Privacy policy explains how we handle personal information. If you accept for a business, you confirm you are authorised to bind it.",
      "You must be at least 16 years old to use Multies.",
    ] },
    { id: "service", title: "The service", body: [
      "Multies is a workspace for email, tasks, chat, docs, calendar and meetings, with an API, webhooks and an MCP server, on the web and in the Multies apps for iPhone and Android. It gives you email in three ways: connect a mailbox you already have at another provider, take a free personal address on mail.multies.si, or host mailboxes and aliases on a domain you own.",
      "When you connect a mailbox from another provider, you confirm you are allowed to use it, and that provider's own terms still apply to it. Multies reads and sends that mailbox's mail over IMAP and SMTP with the app password or sign in you give us. We store it encrypted, use it only to sync and send that mailbox's mail, and delete it when you remove the connection. The original mail stays at your provider; the copy we sync into your workspace is deleted when you remove the connection. Our Privacy policy explains how we handle both.",
      "When you add your own domain, you must own or control it and keep its DNS records in place.",
      "Tools (compress, merge, convert and the other document tools) are provided as is: check each result before you rely on it or send it. Redact blacks out the whole line that contains a match and turns those pages into images, so their text can no longer be selected or searched. Making scans searchable reads English text only for now.",
      "We work to keep Multies available and show its current status on our status page. We do not promise a level of availability.",
      "We improve Multies all the time. We may add, change or remove features; if we remove a feature you pay for, we will tell you first and refund the unused part of what you paid for it.",
    ] },
    { id: "accounts", title: "Accounts", body: [
      "Give us accurate details and keep your sign in safe. Tell us straight away if you think someone else has access. You are responsible for what happens in your workspace, including actions by members, guests and API keys or agents you add.",
    ] },
    { id: "plans", title: "Free plan, add ons and billing", body: [
      "The Free plan costs nothing and has no time limit. You can buy small paid add ons, such as extra domains, storage, mailboxes and sending capacity, at the prices shown on our pricing page.",
      "Prices are in Australian dollars and exclude GST; where GST applies it is added at checkout and shown on your tax invoice. Add ons are billed in advance through our payments provider, monthly, or yearly when your add ons total under A$5 a month, and renew automatically until you remove them.",
      "Adding an add on takes effect straight away and is charged pro rata for the rest of the billing period. Removing one or cancelling takes effect at the end of the paid period, and you keep it until then.",
      "If a payment fails we retry it and email you. Your workspace keeps working during a grace period of 7 days. After that, sending is paused until payment is made; receiving and access to existing mail continue for a further 30 days before we may close the workspace, with notice.",
      "We will give you at least 30 days notice by email before a price increase for an add on you already have. You can remove it before the new price applies.",
    ] },
    { id: "refunds", title: "Refunds and your consumer rights", body: [
      "You can remove an add on or cancel at any time. Except as set out in these terms or required by law, payments already made are not refunded for part of a billing period.",
      "Our services come with guarantees that cannot be excluded under the Australian Consumer Law. Nothing in these terms excludes, restricts or changes those rights. Where our services fail to meet a consumer guarantee, you are entitled to a remedy, which may include a refund.",
      `To ask for a refund, write to ${E.supportEmail} with your workspace name and the invoice.`,
    ] },
    { id: "your-data", title: "Your data", body: [
      "Your mail and content belong to you. You give us permission to store, process and transmit it only to provide and secure the service. You can export it at any time from Settings while your account is open, including after you cancel paid add ons. Deleting your account removes your data straight away, so export what you need first.",
      "You are responsible for having the right to the content you put into Multies and for the instructions you give, including to agents and automations you set up.",
    ] },
    { id: "ours", title: "Our property", body: [
      "Multies, its software, design and brand belong to Fintex. We give you a personal, non transferable right to use Multies under these terms while your account is open. Do not copy, resell, reverse engineer or interfere with the service except as the law allows.",
      "If you send us feedback or ideas, we may use them without owing you anything.",
    ] },
    { id: "acceptable-use", title: "Acceptable use", body: [
      "You must follow the Acceptable use policy, which is part of these terms. It covers spam (including the Spam Act 2003), illegal content and abuse of the network. We may suspend sending, or a workspace, to stop serious harm, and will tell you why.",
      "There is no tolerance for objectionable content or abusive users in chat, direct messages, meetings or anything else people share in Multies. Anyone can report a message or a person and block them. We review every report within one business day and can remove content and suspend accounts. The Acceptable use policy, section \"Objectionable content and abusive users\", sets out the rules.",
    ] },
    { id: "third-party", title: "Other services", body: [
      "Multies can work with services run by others: mailboxes you connect, sign in providers, our payments provider, and any AI provider or app you link to your workspace. Their own terms apply to your use of them, and we are not responsible for services we do not run.",
    ] },
    { id: "liability", title: "Liability", body: [
      "To the extent the law allows, Multies is provided as is, our total liability for any claim connected with these terms or the service is limited to the fees you paid us in the 12 months before the claim (or A$100 if that is more), and we are not liable for indirect or consequential loss, or loss of profit, revenue or data.",
      "Where the Australian Consumer Law applies, our liability for failing to meet a guarantee for services not of a kind ordinarily acquired for personal, domestic or household use is limited, at our choice, to supplying the services again or paying the cost of having them supplied again.",
      "Neither of us is liable for a delay or failure caused by events outside reasonable control, such as a failure of the internet or of a provider we rely on.",
    ] },
    { id: "indemnity", title: "Your responsibility for claims", body: [
      "You will cover our reasonable losses and costs from a claim by someone else arising from mail you send or content you store in breach of these terms or the law, except to the extent we caused it.",
    ] },
    { id: "ending", title: "Ending the agreement", body: [
      "You can cancel at any time in Settings, Billing, or delete your workspace or account. We can end the agreement with 30 days notice, or immediately for a serious breach such as sending spam or illegal content.",
      "When the agreement ends, your right to use Multies stops. We delete your data as set out in the Privacy policy, so export what you need before you delete your account. Sections that by their nature should survive, such as liability, survive.",
    ] },
    { id: "changes", title: "Changes, law and contact", body: [
      "We may update these terms. We will give at least 30 days notice by email of changes that reduce your rights; if you do not agree, you can cancel before they apply. The date at the top shows the version in force.",
      "These terms are governed by the laws of New South Wales, Australia, and you and we submit to the non exclusive jurisdiction of the courts of New South Wales and the courts that hear appeals from them.",
      "If any part of these terms cannot be enforced, the rest still applies. These terms, with the policies they name, are the whole agreement between us about Multies.",
      `${LEGAL_LINE_TEXT}`,
    ] },
  ],
};

export const AUP: LegalDoc = {
  slug: "acceptable-use",
  title: "Acceptable use policy",
  summary: "What you can and cannot send or share through Multies, shaped by the Spam Act 2003.",
  sections: [
    { id: "scope", title: "Scope", body: [
      `This policy is part of the Terms of service between you and ${E.name}. It applies to everyone who uses Multies, including members, guests, API keys and agents, and takes effect on ${LEGAL_EFFECTIVE}.`,
    ] },
    { id: "spam", title: "Commercial email and the Spam Act 2003", body: [
      "Every commercial electronic message sent through Multies must meet the three rules of the Spam Act 2003 (Cth):",
      { list: [
        "Consent: the recipient asked for it, or there is inferred consent from an existing business relationship and the message relates to it. Purchased, rented or scraped lists are never consent.",
        "Identify: the message clearly identifies you as the sender and how to contact you.",
        "Unsubscribe: it has a working unsubscribe that is honoured within 5 working days and costs nothing to use.",
      ] },
      "The same standards apply to recipients outside Australia, together with their local laws (for example CAN SPAM and GDPR).",
    ] },
    { id: "prohibited", title: "Never allowed", body: [
      { list: [
        "Phishing, impersonation, spoofing a domain you do not control, or malware.",
        "Illegal content, including child abuse material, which we report to the authorities.",
        "Harassment, threats, or doxxing.",
        "Sending to addresses you have no relationship with, or mailing lists you did not build yourself.",
        "Trying to get around rate limits, send caps or suspensions, or probing other customers' accounts.",
        "Reselling Multies as a bulk sending service without our written agreement.",
      ] },
    ] },
    { id: "objectionable", title: "Objectionable content and abusive users", body: [
      "Multies has no tolerance for objectionable content or abusive users. This covers chat, direct messages, meeting chat, comments, docs and anything else you share with other people. Never post or send:",
      { list: [
        "Harassment, bullying, threats, or content that encourages violence or self harm.",
        "Hate speech, or attacks on people for who they are.",
        "Sexual content involving anyone without their consent, or involving any minor in any way.",
        "Spam, scams or repeated unwanted messages.",
        "Illegal content of any kind.",
      ] },
      "Anyone can report a message or a person, and block someone so they no longer see that person's messages and that person can't message them. The blocked person is not told.",
      `We review every report within one business day. We can remove the content and suspend the account of anyone who breaks these rules, without notice for serious cases. To contact us about content or a person, write to ${E.abuseEmail}.`,
    ] },
    { id: "limits", title: "Sending limits", body: [
      "Each workspace has a daily sending limit shown in your dashboard. Multies is built for person to person and transactional email. Newsletters are allowed to opted in lists that meet the rules above, within your limits.",
      "Keep complaint rates below 0.1% and bounce rates below 5%. Repeated hard bounces add the address to your suppression list automatically.",
    ] },
    { id: "enforcement", title: "What we do about abuse", body: [
      "Automated checks score outbound mail for spam signals. High scoring messages are held, not sent. A new workspace with several held messages in a day is suspended pending review. We may also limit sending, suspend a workspace, or end the account for serious or repeated breaches, and we keep a record of each action.",
      "We will tell you what happened and how to fix it. If you think we got it wrong, reply to the notice.",
    ] },
    { id: "report", title: "Report abuse", body: [
      `Send the full message, with headers, to ${E.abuseEmail}. We act on reports within one business day.`,
      `${LEGAL_LINE_TEXT}`,
    ] },
  ],
};

export const DPA: LegalDoc = {
  slug: "dpa",
  title: "Data processing agreement",
  summary: "The terms that apply when Multies processes personal information on your behalf (GDPR Article 28 and APP 8).",
  sections: [
    { id: "parties", title: "Parties and scope", body: [
      `This agreement is between the customer named on the Multies account ("Customer", controller) and ${E.name}, ABN ${E.abn} ("Fintex", processor). It forms part of the Terms of service, takes effect on ${LEGAL_EFFECTIVE} and applies whenever Fintex processes personal data on the Customer's behalf through Multies: mail content, tasks, messages, docs and files, mailbox and alias addresses, and the people the Customer corresponds with. It applies automatically when the Customer accepts the Terms; no signature is needed. A countersigned copy is available on request from ${E.privacyEmail}.`,
    ] },
    { id: "details", title: "Details of processing", body: [
      { table: [
        ["Item", "Description"],
        ["Subject matter", "Providing Multies: email hosting, sending and receiving, and the workspace tools around it"],
        ["Duration", "The term of the Terms of service, plus up to 30 days for deletion from backups"],
        ["Nature and purpose", "Storage, transmission, spam and authentication filtering, delivery logging, search, backups"],
        ["Personal data", "Names, email addresses, message headers and content, attachments, workspace content, IP addresses in delivery records"],
        ["Data subjects", "The Customer's users and the people they correspond with"],
        ["Special categories", "Not intended; may appear in content, which is treated as confidential"],
      ] },
    ] },
    { id: "obligations", title: "Fintex's obligations", body: [
      { list: [
        "Process personal data only on the Customer's documented instructions, which are the Terms, this agreement and the Customer's use of the product settings.",
        "Ensure staff with access are bound by confidentiality.",
        "Apply the security measures in section 6.",
        "Use sub processors only as set out in section 5.",
        "Help the Customer answer data subject requests, mainly through the self serve export and deletion tools.",
        "Help the Customer with security, breach notification and impact assessments, taking into account the information available to Fintex.",
        "Notify the Customer without undue delay, and within 48 hours, after becoming aware of a personal data breach affecting the Customer's data.",
        "At the end of the service, delete the Customer's data (live data immediately, backups within 30 days) unless the law requires retention. Export is available before deletion.",
        "Make available the information needed to show compliance, and allow audits by the Customer or its auditor once a year with 30 days notice, at the Customer's cost, or by sharing an independent report where one exists.",
      ] },
    ] },
    { id: "customer", title: "Customer's obligations", body: [
      "The Customer is responsible for having a lawful basis for the mail it sends and the content it stores, for the Spam Act 2003 and similar laws, and for the instructions it gives.",
    ] },
    { id: "subprocessors", title: "Sub processors", body: [
      "The Customer gives general authorisation for the sub processors below. Fintex will give at least 30 days notice of a new sub processor by email; the Customer may object on reasonable data protection grounds and, if no solution is found, end the affected service and receive a pro rata refund. Fintex stays responsible for its sub processors.",
      { table: SUBPROCESSORS },
    ] },
    { id: "security", title: "Security measures", body: [
      { list: [
        "Encryption in transit (TLS 1.2 or later) and at rest; secrets, signing keys and connected mailbox passwords encrypted again under a key held outside the database.",
        "Sign in through a dedicated identity provider with lockout, optional two factor authentication and single sign on enforcement per workspace.",
        "Least privilege access for staff, with every administrative action written to an audit log.",
        "Strict security headers and content security policy, rate limits, and input validation on every endpoint.",
        "Point in time database recovery and encrypted exports before schema changes, with a tested restore runbook.",
        "Monitoring, error tracking and an incident response runbook.",
      ] },
    ] },
    { id: "transfers", title: "International transfers", body: [
      "Customer data is stored with the sub processors listed, with the primary database placed in our hosting provider's Oceania region. Where personal data from the EEA, UK or Switzerland is transferred to a country without an adequacy decision, the Standard Contractual Clauses (module 2 or 3 as applicable) are incorporated by reference. For Australian personal information, Fintex takes reasonable steps under APP 8 so overseas recipients comply with the APPs.",
    ] },
    { id: "general", title: "General", body: [
      "If this agreement conflicts with the Terms on data protection, this agreement wins. Liability is as set out in the Terms. This agreement is governed by the laws of New South Wales, Australia, except where the Standard Contractual Clauses require otherwise.",
      `${LEGAL_LINE_TEXT}`,
    ] },
  ],
};

export const LEGAL_DOCS = { privacy: PRIVACY, terms: TERMS, "acceptable-use": AUP, dpa: DPA } as const;
export type LegalSlug = keyof typeof LEGAL_DOCS;
