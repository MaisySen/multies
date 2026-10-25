/**
 * Legal documents. DRAFTS written against the Australian Privacy Principles (Privacy
 * Act 1988), the Spam Act 2003, the Australian Consumer Law and GDPR basics. They must
 * be reviewed by a lawyer before launch; every page says so. Operator name, ABN and
 * contact in LEGAL_ENTITY were filled in by the owner on 25 October 2026 from the company
 * runbook (company.md), which also sets the location (no street address) and LEGAL_LINE.
 */
export const LEGAL_ENTITY = {
  name: "Fintex Australia Pty Ltd",
  abn: "60 688 406 108",
  acn: "688 406 108",
  address: "New South Wales, Australia (NSW 2135)",
  // privacy@, abuse@ and support@multies.si are not read mailboxes yet (docs/runbooks/multies-si-mailboxes.md),
  // so every public contact uses the company address from the runbook until they are routed into an inbox.
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

export const LEGAL_UPDATED = "25 October 2026";

export type Block = string | { list: string[] } | { table: string[][] };
export interface LegalSection { id: string; title: string; body: Block[] }
export interface LegalDoc { slug: string; title: string; summary: string; sections: LegalSection[] }

const E = LEGAL_ENTITY;

export const SUBPROCESSORS: string[][] = [
  ["Provider", "What they do for us", "Data", "Where"],
  ["Cloudflare", "Hosting, database (D1), edge network, DDoS protection", "All service data", "Primary database placed in Cloudflare's Oceania region (a location hint; Cloudflare does not commit to a country); edge worldwide"],
  ["Resend", "Delivery of outbound email to other providers", "Outbound messages and their recipients", "United States"],
  ["Stripe", "Payments and invoices", "Billing contact, card details (held by Stripe, never by us)", "Australia and United States"],
  ["Sentry", "Error and performance monitoring", "Error reports with account ids; no message content", "United States"],
  ["Google, GitHub, Auth0", "Optional sign in, only if you choose it", "Name, email, provider account id", "United States"],
  ["Your AI provider (OpenAI, Anthropic, OpenRouter or Groq)", "Only if your workspace adds its own API key: the assistant sends the thread you ask about to that provider, on your account with them", "The email thread you ask the assistant about", "Set by the provider you choose (mostly United States)"],
];

export const PRIVACY: LegalDoc = {
  slug: "privacy",
  title: "Privacy policy",
  summary: "What we collect, why, who we share it with, and how to see, export or delete it.",
  sections: [
    { id: "who", title: "Who we are", body: [
      `Multies is run by ${E.name}, ABN ${E.abn}, ACN ${E.acn}, ${E.address} ("we", "us"). We provide email for businesses and people: hosting on domains our customers own, free personal addresses on mail.multies.si, and connections to mailboxes people already have at other providers. This policy explains how we handle personal information under the Privacy Act 1988 (Cth) and the Australian Privacy Principles (APPs), and, for people in the European Economic Area or the United Kingdom, under the GDPR.`,
      `Questions or requests: ${E.privacyEmail}. We answer within 30 days, usually much sooner.`,
    ] },
    { id: "roles", title: "Our two roles", body: [
      "For your account details (name, email, sign in, billing) we decide how the data is used, so we are the controller.",
      "For the mail in your mailboxes and the people you correspond with, your workspace decides, and we process it on your behalf as a processor. Our Data Processing Agreement sets out those terms.",
    ] },
    { id: "collect", title: "What we collect", body: [
      { list: [
        "Account: name, email address, password hash (never the password itself), two factor settings, sign in method.",
        "Workspace: domains, mailboxes, aliases, members and roles, settings, API keys (stored hashed), webhook endpoints.",
        "Mail: messages you send and receive, attachments, folders and flags, and delivery records (sender, recipient, time, result).",
        "Connected mailboxes: the address, the provider's server names, and the app password or sign in you give us, stored encrypted. We also keep a copy of the synced mail (see Connected mailboxes below).",
        "Free addresses: the name you choose on mail.multies.si, and, to stop abuse, a record of each claim with the network and a random device id from your browser.",
        "Billing: plan, invoices and the Stripe customer id. Card details go straight to Stripe and never reach our servers.",
        "Security and usage: IP address, browser and device for each session, an audit log of changes, and request logs kept for 30 days.",
        "Support: what you send us when you contact us.",
      ] },
      "We do not buy personal information, and we do not collect sensitive information (as defined in the Privacy Act) on purpose. Mail you receive may contain it; we treat all mail content as confidential.",
    ] },
    { id: "connected", title: "Connected mailboxes", body: [
      "You can connect a mailbox you already have at another provider, such as Gmail, Outlook, Yahoo, iCloud, Zoho or your own server.",
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
        ["Run the service: store and deliver your mail, keep you signed in", "Performance of our contract with you"],
        ["Bill you and keep tax records", "Contract; legal obligation"],
        ["Keep accounts and the network safe: rate limits, lockout, spam and abuse checks on outbound mail", "Legitimate interests (security); legal obligation"],
        ["Fix errors and measure reliability", "Legitimate interests"],
        ["Service emails: verification, password reset, security alerts, receipts, usage alerts", "Contract"],
      ] },
      "We do not read your mail. Automated checks scan outbound messages for spam signals and inbound messages for spam and authentication results; no person reviews content unless you ask us to in a support request, or the law requires it.",
      "We do not sell personal information, show ads, or use your mail to train models.",
    ] },
    { id: "share", title: "Who we share it with", body: [
      "Only the service providers below, under contracts that require them to protect it, and only for the purposes above:",
      { table: SUBPROCESSORS },
      "We may also disclose information if Australian law requires it (for example a valid warrant), and we will tell you unless the law forbids it.",
    ] },
    { id: "overseas", title: "Overseas disclosure (APP 8)", body: [
      "Our primary database is placed in Cloudflare's Oceania region. Cloudflare treats that as a location hint and does not commit to a country, and requests are handled at the edge location nearest you. Some providers listed above process data in the United States. We take reasonable steps, including contractual commitments and, for European data, Standard Contractual Clauses, so they handle it consistently with the APPs and the GDPR.",
    ] },
    { id: "cookies", title: "Cookies", body: [
      "We use only cookies that are strictly necessary: a session cookie that keeps you signed in and a short lived cookie that protects sign in. There are no advertising or analytics cookies. Our visitor analytics (Cloudflare Web Analytics) is cookieless and stores nothing on your device. Error monitoring does not set cookies. We show a short notice about this once; closing it saves a small note in your browser's local storage so it stays closed.",
    ] },
    { id: "keep", title: "How long we keep it", body: [
      { list: [
        "Account and workspace data: while your account is open.",
        "Mail: until you or your workspace delete it.",
        "Connected mailbox passwords: until you remove the connection, then deleted straight away. Synced copies of its mail: until you remove the connection or delete them.",
        "Free address claim records: for the life of the account, so the one address per person limit holds.",
        "After you delete your account or workspace: removed from the live database straight away, and from encrypted backups within 30 days.",
        "Request logs: 30 days. Audit logs: for the life of the workspace. Invoices: 7 years, as Australian tax law requires.",
      ] },
    ] },
    { id: "security", title: "Security", body: [
      "Data is encrypted in transit (TLS) and at rest. Passwords are hashed; signing keys, secrets and connected mailbox passwords are encrypted; sign in has lockout and optional two factor authentication, and every change is in an audit log. See our security policy at /.well-known/security.txt to report a problem.",
      "If a data breach is likely to cause serious harm, we will notify you and the Office of the Australian Information Commissioner (OAIC) under the Notifiable Data Breaches scheme, and, where the GDPR applies, the relevant authority within 72 hours.",
    ] },
    { id: "rights", title: "Your rights", body: [
      "You can, at any time and without charge:",
      { list: [
        "See and download your data: Settings, Account, Your data. Workspace owners can export everything, mail included, from Settings, General.",
        "Correct it: edit your profile, or ask us.",
        "Delete it: Settings, Account, Delete account.",
        "Object to or restrict processing, or ask for portability, by emailing us.",
      ] },
      `If you are unhappy with how we handled your information, contact ${E.privacyEmail} first. If we do not resolve it within 30 days you can complain to the OAIC (oaic.gov.au, 1300 363 992) or, in Europe, your local data protection authority.`,
    ] },
    { id: "changes", title: "Changes", body: [
      "We will email account owners at least 30 days before a material change. The date at the top shows the latest version.",
    ] },
  ],
};

export const TERMS: LegalDoc = {
  slug: "terms",
  title: "Terms of service",
  summary: "The agreement between your business and us when you use Multies.",
  sections: [
    { id: "agreement", title: "The agreement", body: [
      `These terms are between ${E.name}, ABN ${E.abn} ("we") and the person or business that creates a Multies account ("you"). By creating an account you agree to them, to the Acceptable use policy, and, where we process personal information for you, to the Data Processing Agreement. If you accept for a business, you confirm you can bind it.`,
    ] },
    { id: "service", title: "The service", body: [
      "Multies gives you email in three ways: connect a mailbox you already have at another provider, take a free personal address on mail.multies.si, or host mailboxes and aliases on a domain you own. Around your email it offers webmail, tasks, chat, meetings, an API and webhooks.",
      "When you connect a mailbox from another provider, you confirm you are allowed to use it, and that provider's own terms still apply to it. Multies reads and sends that mailbox's mail over IMAP and SMTP with the app password or sign in you give us. We store it encrypted, use it only to sync and send that mailbox's mail, and delete it when you remove the connection. The original mail stays at your provider; the copy we sync into your workspace is deleted when you remove the connection. Our Privacy policy explains how we handle both.",
      "When you add your own domain, you must own or control it and keep its DNS records in place.",
      "We aim for 99.9% monthly availability for mail delivery and the API, measured on our status page. This is a target, not a guarantee, unless your plan includes a written service level.",
    ] },
    { id: "accounts", title: "Accounts", body: [
      "Keep your sign in details safe and tell us straight away if you think someone else has access. You are responsible for what happens in your workspace, including actions by members you invite.",
    ] },
    { id: "plans", title: "Plans, billing and cancellation", body: [
      "Prices are in Australian dollars and exclude GST; where GST applies it is added at checkout and shown on your invoice. The Free plan costs nothing. Add-ons are billed through Stripe in advance, monthly, or yearly when your add-ons total under A$5 a month, and renew automatically until you remove them.",
      "Upgrades take effect immediately and are prorated. Downgrades and cancellations take effect at the end of the paid period; you keep access until then.",
      "If a payment fails we retry it and email you. Your workspace keeps working during a grace period of 7 days. After that, sending is paused until payment is made; receiving and access to existing mail continue for a further 30 days before we may close the workspace, with notice.",
      "Nothing in these terms excludes rights you have under the Australian Consumer Law. Where our services fail to meet a consumer guarantee, you are entitled to a remedy.",
    ] },
    { id: "your-data", title: "Your data", body: [
      "Your mail and content belong to you. You give us permission to store, process and transmit it only to provide the service. You can export it at any time, and for 30 days after cancellation on request.",
    ] },
    { id: "acceptable-use", title: "Acceptable use", body: [
      "You must follow the Acceptable use policy, which is part of these terms. It covers spam (including the Spam Act 2003), illegal content and abuse of the network. We may suspend sending, or a workspace, to stop serious harm, and will tell you why.",
    ] },
    { id: "liability", title: "Liability", body: [
      "To the extent the law allows, our total liability for any claim is limited to the fees you paid us in the 12 months before the claim, and we are not liable for indirect or consequential loss. Where the Australian Consumer Law applies, our liability for failing to meet a guarantee for services not of a kind ordinarily acquired for personal use is limited to supplying the services again or paying for that.",
      "You are responsible for claims arising from mail you send or content you store in breach of these terms.",
    ] },
    { id: "ending", title: "Ending the agreement", body: [
      "You can cancel at any time in Settings, Billing, or delete your workspace. We can end the agreement with 30 days notice, or immediately for a serious breach such as sending spam or illegal content.",
    ] },
    { id: "changes", title: "Changes and law", body: [
      "We will give at least 30 days notice by email of changes that reduce your rights. These terms are governed by the law of New South Wales, Australia, and the courts of New South Wales have jurisdiction.",
      `Contact: ${E.supportEmail}.`,
    ] },
  ],
};

export const AUP: LegalDoc = {
  slug: "acceptable-use",
  title: "Acceptable use policy",
  summary: "What you can and cannot send through Multies, shaped by the Spam Act 2003.",
  sections: [
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
    { id: "limits", title: "Sending limits", body: [
      "Each plan has a daily sending limit shown in your dashboard. Multies is built for person to person and transactional email. Newsletters are allowed to opted in lists that meet the rules above, at volumes your plan allows.",
      "Keep complaint rates below 0.1% and bounce rates below 5%. Repeated hard bounces add the address to your suppression list automatically.",
    ] },
    { id: "enforcement", title: "What we do about abuse", body: [
      "Automated checks score outbound mail for spam signals. High scoring messages are held, not sent. A new workspace with several held messages in a day is suspended pending review. We may also limit sending, suspend a workspace, or end the account for serious or repeated breaches, and we keep a record of each action.",
      "We will tell you what happened and how to fix it. If you think we got it wrong, reply to the notice.",
    ] },
    { id: "report", title: "Report abuse", body: [
      `Send the full message, with headers, to ${E.abuseEmail}. We act on reports within one business day.`,
    ] },
  ],
};

export const DPA: LegalDoc = {
  slug: "dpa",
  title: "Data processing agreement",
  summary: "Template terms for when Multies processes personal information on your behalf (GDPR Article 28 and APP 8).",
  sections: [
    { id: "parties", title: "Parties and scope", body: [
      `This agreement is between the customer named on the Multies account ("Customer", controller) and ${E.name}, ABN ${E.abn} ("Multies", processor). It forms part of the Terms of service and applies when Multies processes personal data on the Customer's behalf: mail content, mailbox and alias addresses, and the people the Customer corresponds with. To sign a countersigned copy, email ${E.privacyEmail}.`,
    ] },
    { id: "details", title: "Details of processing", body: [
      { table: [
        ["Item", "Description"],
        ["Subject matter", "Hosting, sending and receiving email for the Customer's domains"],
        ["Duration", "The term of the Terms of service, plus up to 30 days for deletion from backups"],
        ["Nature and purpose", "Storage, transmission, spam and authentication filtering, delivery logging, backups"],
        ["Personal data", "Names, email addresses, message headers and content, attachments, IP addresses in delivery records"],
        ["Data subjects", "The Customer's users and the people they correspond with"],
        ["Special categories", "Not intended; may appear in mail content, which is treated as confidential"],
      ] },
    ] },
    { id: "obligations", title: "Multies' obligations", body: [
      { list: [
        "Process personal data only on the Customer's documented instructions, which are the Terms, this agreement and the Customer's use of the product settings.",
        "Ensure staff with access are bound by confidentiality.",
        "Apply the security measures in section 6.",
        "Use sub processors only as set out in section 5.",
        "Help the Customer answer data subject requests, mainly through the self serve export and deletion tools.",
        "Help the Customer with security, breach notification and impact assessments, taking into account the information available to Multies.",
        "Notify the Customer without undue delay, and within 48 hours, after becoming aware of a personal data breach affecting the Customer's data.",
        "At the end of the service, delete the Customer's data (live data immediately, backups within 30 days) unless the law requires retention. Export is available before deletion.",
        "Make available the information needed to show compliance, and allow audits by the Customer or its auditor once a year with 30 days notice, at the Customer's cost, or by sharing an independent report where one exists.",
      ] },
    ] },
    { id: "customer", title: "Customer's obligations", body: [
      "The Customer is responsible for having a lawful basis for the mail it sends and stores, for the Spam Act 2003 and similar laws, and for the instructions it gives.",
    ] },
    { id: "subprocessors", title: "Sub processors", body: [
      "The Customer gives general authorisation for the sub processors below. Multies will give at least 30 days notice of a new sub processor by email; the Customer may object on reasonable data protection grounds and, if no solution is found, end the affected service and receive a prorated refund. Multies stays responsible for its sub processors.",
      { table: SUBPROCESSORS },
    ] },
    { id: "security", title: "Security measures", body: [
      { list: [
        "Encryption in transit (TLS 1.2 or later) and at rest; secrets and signing keys encrypted with keys held outside the database.",
        "Password hashing, sign in lockout, optional two factor authentication and single sign on enforcement per workspace.",
        "Least privilege access for staff, with every administrative action written to an audit log.",
        "Strict security headers and content security policy, rate limits, input validation on every endpoint.",
        "Automated dependency, secret and code scanning in CI, and a weekly dynamic scan.",
        "Point in time database recovery for 30 days and encrypted nightly backups, with a tested restore runbook.",
        "Monitoring, error tracking and an incident response runbook.",
      ] },
    ] },
    { id: "transfers", title: "International transfers", body: [
      "Customer data is stored with the subprocessors listed, with the primary database placed in Cloudflare's Oceania region. Where personal data from the EEA, UK or Switzerland is transferred to a country without an adequacy decision, the Standard Contractual Clauses (module 2 or 3 as applicable) are incorporated by reference. For Australian personal information, Multies takes reasonable steps under APP 8 so overseas recipients comply with the APPs.",
    ] },
    { id: "general", title: "General", body: [
      "If this agreement conflicts with the Terms on data protection, this agreement wins. Liability is as set out in the Terms. Governing law is that of the Terms, except where the Standard Contractual Clauses require otherwise.",
    ] },
  ],
};

export const LEGAL_DOCS = { privacy: PRIVACY, terms: TERMS, "acceptable-use": AUP, dpa: DPA } as const;
export type LegalSlug = keyof typeof LEGAL_DOCS;
