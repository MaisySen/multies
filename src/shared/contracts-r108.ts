/**
 * R108 Contracts: plain words contract templates, a guided interview that fills them, a clause library with
 * versions and renewal reminders. Pure rules shared by the server (which checks and saves) and the web page
 * (which previews live). The interview is rules in code: no AI, no eval. Every template and every generated
 * document carries CONTRACT_NOTE.
 *
 * Clause bodies are plain text. Paragraphs are split by a blank line. {{key}} puts in an answer, and a line on
 * its own of [[if key]], [[if not key]], [[if key = value]] or [[if key != value]] up to [[end]] keeps the lines
 * between only when the test holds. An unknown {{key}} prints as a blank line to fill in by hand.
 */

export const CONTRACT_NOTE = "This is a template, not legal advice.";
export const CONTRACT_NOTE_LONG = "This is a template, not legal advice. It is written in plain words for Australian small businesses and has not been reviewed for your situation. Read it carefully and get advice from a lawyer if you are unsure.";
export const BLANK = "________________";

export const CONTRACT_LIMITS = { name: 80, description: 240, clauseTitle: 80, clauseBody: 8000, clausesPerTemplate: 30, answer: 2000, longAnswer: 6000 } as const;

export type QuestionType = "text" | "textarea" | "date" | "money" | "number" | "email" | "choice" | "yesno" | "abn";
export interface Choice { value: string; label: string }
export interface Question {
  key: string; label: string; type: QuestionType; section: string;
  help?: string; required?: boolean; options?: Choice[]; when?: string;
  min?: number; max?: number; after?: string; placeholder?: string; defaultValue?: string;
}
export interface ClauseRef { key: string; when?: string }
export interface ReminderRule { dateKey: string; offsetDays: number; offsetKey?: string; title: string; when?: string }
export interface ContractTemplateDef {
  id: string; name: string; description: string; category: string;
  titlePattern: string; partiesLine: string;
  questions: Question[]; clauses: ClauseRef[]; reminders: ReminderRule[];
}
export interface ClauseText { key: string; title: string; body: string; version: number }
export type Answers = Record<string, string>;

const STATES: Choice[] = [
  { value: "NSW", label: "New South Wales" }, { value: "VIC", label: "Victoria" }, { value: "QLD", label: "Queensland" },
  { value: "WA", label: "Western Australia" }, { value: "SA", label: "South Australia" }, { value: "TAS", label: "Tasmania" },
  { value: "ACT", label: "Australian Capital Territory" }, { value: "NT", label: "Northern Territory" },
];
const GST: Choice[] = [{ value: "plus", label: "Plus GST" }, { value: "includes", label: "Includes GST" }, { value: "none", label: "No GST (not registered)" }];
const YES_NO: Choice[] = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

// ------------------------------------------------------------------------------------------- standard clauses
export const STANDARD_CLAUSES: Omit<ClauseText, "version">[] = [
  { key: "svc_services", title: "The services", body: "{{provider_name}} will provide these services to {{client_name}}:\n\n{{services}}\n\n{{provider_name}} will do the work with reasonable care and skill, and will tell {{client_name}} quickly about anything that could delay it." },
  { key: "svc_term", title: "How long this agreement lasts", body: "This agreement starts on {{start_date}}.\n\n[[if has_end]]\nIt ends on {{end_date}} unless it is ended earlier under this agreement.\n[[if auto_renew]]\nAt the end date it renews for the same length of time unless either party gives written notice at least {{notice_days}} days before the end date.\n[[end]]\n[[end]]\n[[if not has_end]]\nIt continues until either party ends it under this agreement.\n[[end]]" },
  { key: "svc_fees", title: "Fees", body: "[[if fee_type = fixed]]\n{{client_name}} will pay a fixed fee of {{fee_amount}} ({{gst}}).\n[[end]]\n[[if fee_type = hourly]]\n{{client_name}} will pay {{fee_amount}} an hour ({{gst}}) for time spent on the services, recorded in units of 15 minutes.\n[[end]]\n[[if fee_type = monthly]]\n{{client_name}} will pay {{fee_amount}} a month ({{gst}}), invoiced at the start of each month.\n[[end]]\n\n{{provider_name}} will send tax invoices and {{client_name}} will pay each one within {{payment_days}} days. If an invoice is not paid on time, {{provider_name}} may pause the services after giving 7 days written notice." },
  { key: "ip_client", title: "Who owns the work", body: "Once an invoice for the work is paid, {{client_name}} owns the work made for it under this agreement. {{provider_name}} keeps ownership of its existing tools, know how and materials, and gives {{client_name}} a lasting licence to use any of them that are part of the work." },
  { key: "ip_provider", title: "Who owns the work", body: "{{provider_name}} keeps ownership of the work it makes. Once each invoice is paid, {{client_name}} has a lasting, non exclusive licence to use the work for its own business." },
  { key: "confidentiality", title: "Keeping information private", body: "Each party will keep the other party's confidential information private and use it only for this agreement. This does not cover information that is already public, or that the law requires a party to share. This clause continues after the agreement ends." },
  { key: "liability", title: "Responsibility and limits", body: "Nothing in this agreement takes away rights under the Australian Consumer Law that cannot be excluded.\n\nAs far as the law allows, each party's total responsibility to the other under this agreement is limited to the fees paid or payable in the 12 months before the claim, and neither party is responsible for indirect loss such as lost profits." },
  { key: "termination", title: "Ending the agreement", body: "Either party may end this agreement by giving {{termination_days}} days written notice.\n\nEither party may end it straight away by written notice if the other party seriously breaks it and does not fix the problem within 14 days of being asked to, or becomes insolvent.\n\nWhen it ends, {{client_name}} pays for work done up to the end date." },
  { key: "disputes", title: "Sorting out disagreements", body: "If there is a disagreement, the parties will first talk in good faith to sort it out. If it is not sorted within 30 days, either party may suggest mediation before going to court. This does not stop a party asking a court for urgent help." },
  { key: "law", title: "Which law applies", body: "The law of {{state}}, Australia applies to this agreement, and the courts of that state or territory can hear any case about it." },
  { key: "entire", title: "The whole agreement", body: "This document is the whole agreement between the parties about its subject. Any change must be in writing and agreed by both parties. If any part cannot be enforced, the rest still applies." },
  { key: "gst", title: "GST", body: "[[if gst = plus]]\nPrices in this agreement do not include GST. GST is added to each tax invoice at the current rate.\n[[end]]\n[[if gst = includes]]\nPrices in this agreement include GST.\n[[end]]\n[[if gst = none]]\nThe supplier is not registered for GST, so no GST is charged.\n[[end]]" },
  // NDA
  { key: "nda_purpose", title: "Why information is being shared", body: "[[if nda_kind = mutual]]\n{{party_a}} and {{party_b}} will share confidential information with each other for this purpose: {{purpose}}.\n[[end]]\n[[if nda_kind = one_way]]\n{{discloser}} will share confidential information with the other party for this purpose: {{purpose}}.\n[[end]]" },
  { key: "nda_definition", title: "What counts as confidential", body: "Confidential information means any information shared for the purpose that is marked confidential or that a reasonable person would see as private, such as prices, plans, customer details, designs and know how, in any form." },
  { key: "nda_obligations", title: "Promises about the information", body: "[[if nda_kind = mutual]]\nEach party will:\n[[end]]\n[[if nda_kind = one_way]]\nThe party receiving the information will:\n[[end]]\n\n1. use it only for the purpose;\n2. keep it secure and private;\n3. share it only with its own people and advisers who need it for the purpose and who keep it private too; and\n4. tell the other party quickly if it is shared by mistake." },
  { key: "nda_exceptions", title: "What is not covered", body: "These promises do not cover information that is already public through no fault of the receiving party, that the receiving party already had or makes on its own, or that the law or a court requires it to share (after giving notice where it can)." },
  { key: "nda_term", title: "How long the promises last", body: "This agreement starts on {{start_date}}. The promises last for {{years}} years from that date, and for trade secrets for as long as they stay secret." },
  { key: "nda_return", title: "Giving information back", body: "When asked, the receiving party will return or destroy the confidential information and any copies, except copies it must keep by law." },
  { key: "nda_remedies", title: "If the promises are broken", body: "Money may not be enough to fix a breach of this agreement, so the party sharing information may also ask a court to stop a breach." },
  // Contractor
  { key: "con_relationship", title: "Independent contractor", body: "{{contractor_name}} (ABN {{contractor_abn}}) is an independent contractor, not an employee, partner or agent of {{business_name}}. {{contractor_name}} is responsible for its own tax, superannuation and insurance, and decides how to do the work." },
  { key: "con_work", title: "The work", body: "{{contractor_name}} will do this work for {{business_name}}:\n\n{{work}}\n\nThe work starts on {{start_date}}[[if has_end]] and is expected to finish by {{end_date}}[[end]].\n\n[[if equipment = contractor]]\n{{contractor_name}} supplies its own tools and equipment.\n[[end]]\n[[if equipment = business]]\n{{business_name}} supplies the tools and equipment needed for the work.\n[[end]]" },
  { key: "con_pay", title: "Payment", body: "[[if rate_type = hourly]]\n{{business_name}} will pay {{rate}} an hour ({{gst}}).\n[[end]]\n[[if rate_type = daily]]\n{{business_name}} will pay {{rate}} a day ({{gst}}).\n[[end]]\n[[if rate_type = fixed]]\n{{business_name}} will pay a fixed price of {{rate}} ({{gst}}).\n[[end]]\n\n{{contractor_name}} will send tax invoices showing its ABN, and {{business_name}} will pay each one within {{payment_days}} days." },
  { key: "con_insurance", title: "Insurance", body: "{{contractor_name}} will hold public liability insurance and any other insurance the law requires for the work, and will show proof when asked." },
  { key: "con_ip", title: "Who owns the work", body: "Once paid, {{business_name}} owns what {{contractor_name}} makes for it under this agreement. {{contractor_name}} keeps its existing tools and know how." },
  { key: "con_termination", title: "Ending the agreement", body: "Either party may end this agreement by giving {{termination_days}} days written notice. Either party may end it straight away if the other seriously breaks it. {{business_name}} pays for work done up to the end date." },
  // Quote terms
  { key: "quote_acceptance", title: "Accepting this quote", body: "This quote from {{business_name}} is valid for {{valid_days}} days from the date on it. The customer accepts it by signing, replying in writing or paying a deposit." },
  { key: "quote_deposit", title: "Deposit", body: "A deposit of {{deposit_percent}}% of the quoted price is due on acceptance. Work is booked once the deposit is paid." },
  { key: "quote_payment", title: "Payment", body: "The rest of the price is due within {{payment_days}} days of the invoice. Prices are {{gst}}." },
  { key: "quote_variations", title: "Changes to the work", body: "If the customer asks for changes, {{business_name}} will confirm the extra cost and time in writing before doing them." },
  { key: "quote_cancel", title: "Cancelling", body: "The customer may cancel by written notice at least {{cancel_days}} days before the work is booked to start[[if deposit]], and the deposit is then refunded[[end]]. Later cancellations may be charged for costs already spent." },
  { key: "quote_consumer", title: "Your consumer rights", body: "Our goods and services come with guarantees that cannot be excluded under the Australian Consumer Law. Nothing in these terms limits those rights." },
  // Privacy notice
  { key: "priv_intro", title: "About this notice", body: "This notice explains how {{business_name}} collects, uses and looks after personal information. We follow the Australian Privacy Principles where they apply to us." },
  { key: "priv_collect", title: "What we collect", body: "We collect:\n\n{{collects}}\n\nWe collect it from you directly when you contact us, buy from us or use our services." },
  { key: "priv_use", title: "How we use it", body: "We use personal information to:\n\n{{uses}}\n\nWe do not sell personal information." },
  { key: "priv_disclose", title: "Who we share it with", body: "We share personal information only with service providers who help us run our business (such as payment, hosting and delivery providers), and when the law requires it." },
  { key: "priv_overseas", title: "Overseas", body: "Some of our service providers store information outside Australia, in {{overseas_countries}}. We take reasonable steps to make sure they protect it." },
  { key: "priv_marketing", title: "Marketing", body: "We may send you news and offers. Every message has an easy way to unsubscribe, and you can ask us to stop at any time." },
  { key: "priv_security", title: "Keeping it safe", body: "We take reasonable steps to protect personal information from misuse, loss and unauthorised access, and we delete it when we no longer need it." },
  { key: "priv_access", title: "Seeing and fixing your information", body: "You can ask to see or correct the personal information we hold about you by emailing {{contact_email}}." },
  { key: "priv_complaints", title: "Questions and complaints", body: "If you have a question or complaint about privacy, email {{contact_email}}. We will reply within 30 days. If you are not happy with our answer, you can contact the Office of the Australian Information Commissioner." },
];
export const standardClause = (key: string) => STANDARD_CLAUSES.find((c) => c.key === key) ?? null;

// ------------------------------------------------------------------------------------------- standard templates
const q = (key: string, label: string, type: QuestionType, section: string, extra: Partial<Question> = {}): Question => ({ key, label, type, section, required: true, ...extra });

export const STANDARD_TEMPLATES: ContractTemplateDef[] = [
  {
    id: "std-service", name: "Service agreement", category: "Clients", description: "For doing work for a client: what you will do, fees, payment, who owns the work and how it ends.",
    titlePattern: "Service agreement: {{provider_name}} and {{client_name}}", partiesLine: "Between {{provider_name}}[[if provider_abn]] (ABN {{provider_abn}})[[end]] and {{client_name}}[[if client_abn]] (ABN {{client_abn}})[[end]]",
    questions: [
      q("provider_name", "Your business name", "text", "Parties", { defaultValue: "{{workspace_name}}" }),
      q("provider_abn", "Your ABN", "abn", "Parties", { required: false, help: "11 digits. Leave empty if you don't have one." }),
      q("client_name", "Client name", "text", "Parties", { placeholder: "Bright Bakery Pty Ltd" }),
      q("client_abn", "Client ABN", "abn", "Parties", { required: false }),
      q("services", "What will you do?", "textarea", "The work", { help: "Describe the services in a few plain lines." }),
      q("fee_type", "How will you charge?", "choice", "Money", { options: [{ value: "fixed", label: "A fixed fee" }, { value: "hourly", label: "By the hour" }, { value: "monthly", label: "Monthly" }] }),
      q("fee_amount", "Amount", "money", "Money", { min: 0 }),
      q("gst", "GST", "choice", "Money", { options: GST, defaultValue: "plus" }),
      q("payment_days", "Days to pay each invoice", "number", "Money", { min: 0, max: 120, defaultValue: "14" }),
      q("start_date", "Start date", "date", "Dates", { defaultValue: "{{today}}" }),
      q("has_end", "Does it have an end date?", "yesno", "Dates", { options: YES_NO, defaultValue: "yes" }),
      q("end_date", "End date", "date", "Dates", { when: "has_end", after: "start_date" }),
      q("auto_renew", "Renew automatically at the end?", "yesno", "Dates", { when: "has_end", options: YES_NO, defaultValue: "no" }),
      q("notice_days", "Notice needed to stop renewal (days)", "number", "Dates", { when: "auto_renew", min: 1, max: 365, defaultValue: "30" }),
      q("termination_days", "Notice to end early (days)", "number", "Ending", { min: 0, max: 365, defaultValue: "30" }),
      q("ip_owner", "Who owns the finished work?", "choice", "Ending", { options: [{ value: "client", label: "The client, once paid" }, { value: "provider", label: "You, with a licence for the client" }], defaultValue: "client" }),
      q("state", "Which state's law applies?", "choice", "Ending", { options: STATES, defaultValue: "NSW" }),
    ],
    clauses: [{ key: "svc_services" }, { key: "svc_term" }, { key: "svc_fees" }, { key: "gst" }, { key: "ip_client", when: "ip_owner = client" }, { key: "ip_provider", when: "ip_owner = provider" }, { key: "confidentiality" }, { key: "liability" }, { key: "termination" }, { key: "disputes" }, { key: "law" }, { key: "entire" }],
    reminders: [
      { dateKey: "end_date", offsetDays: -7, offsetKey: "notice_days", title: "Decide on renewal before the notice date: {{title}}", when: "auto_renew" },
      { dateKey: "end_date", offsetDays: -30, title: "Review before it ends: {{title}}", when: "not auto_renew" },
      { dateKey: "end_date", offsetDays: 0, title: "Agreement ends: {{title}}" },
    ],
  },
  {
    id: "std-nda", name: "Confidentiality agreement (NDA)", category: "Partners", description: "Before you share private plans, prices or ideas. Mutual or one way.",
    titlePattern: "Confidentiality agreement: {{party_a}} and {{party_b}}", partiesLine: "Between {{party_a}} and {{party_b}}",
    questions: [
      q("party_a", "First party", "text", "Parties", { defaultValue: "{{workspace_name}}" }),
      q("party_b", "Second party", "text", "Parties"),
      q("nda_kind", "Who is sharing information?", "choice", "Parties", { options: [{ value: "mutual", label: "Both parties (mutual)" }, { value: "one_way", label: "Only one party (one way)" }], defaultValue: "mutual" }),
      q("discloser", "Which party is sharing?", "text", "Parties", { when: "nda_kind = one_way", help: "Type the name exactly as above." }),
      q("purpose", "Why is it being shared?", "textarea", "Details", { placeholder: "To talk about working together on a new product" }),
      q("start_date", "Start date", "date", "Details", { defaultValue: "{{today}}" }),
      q("years", "How many years should it last?", "number", "Details", { min: 1, max: 10, defaultValue: "2" }),
      q("state", "Which state's law applies?", "choice", "Details", { options: STATES, defaultValue: "NSW" }),
    ],
    clauses: [{ key: "nda_purpose" }, { key: "nda_definition" }, { key: "nda_obligations" }, { key: "nda_exceptions" }, { key: "nda_term" }, { key: "nda_return" }, { key: "nda_remedies" }, { key: "law" }, { key: "entire" }],
    reminders: [{ dateKey: "start_date", offsetDays: 0, offsetKey: "years", title: "Confidentiality period ends: {{title}}" }],
  },
  {
    id: "std-contractor", name: "Contractor agreement", category: "People", description: "For hiring an independent contractor: the work, pay, insurance and who owns the result.",
    titlePattern: "Contractor agreement: {{business_name}} and {{contractor_name}}", partiesLine: "Between {{business_name}} and {{contractor_name}} (ABN {{contractor_abn}})",
    questions: [
      q("business_name", "Your business name", "text", "Parties", { defaultValue: "{{workspace_name}}" }),
      q("contractor_name", "Contractor name", "text", "Parties"),
      q("contractor_abn", "Contractor ABN", "abn", "Parties", { help: "A contractor should have an ABN. 11 digits." }),
      q("work", "What work will they do?", "textarea", "The work"),
      q("equipment", "Who supplies tools and equipment?", "choice", "The work", { options: [{ value: "contractor", label: "The contractor" }, { value: "business", label: "Your business" }], defaultValue: "contractor" }),
      q("insurance", "Must the contractor hold insurance?", "yesno", "The work", { options: YES_NO, defaultValue: "yes" }),
      q("rate_type", "How will you pay?", "choice", "Money", { options: [{ value: "hourly", label: "By the hour" }, { value: "daily", label: "By the day" }, { value: "fixed", label: "A fixed price" }] }),
      q("rate", "Amount", "money", "Money", { min: 0 }),
      q("gst", "GST", "choice", "Money", { options: GST, defaultValue: "plus" }),
      q("payment_days", "Days to pay each invoice", "number", "Money", { min: 0, max: 120, defaultValue: "14" }),
      q("start_date", "Start date", "date", "Dates", { defaultValue: "{{today}}" }),
      q("has_end", "Is there an expected end date?", "yesno", "Dates", { options: YES_NO, defaultValue: "no" }),
      q("end_date", "Expected end date", "date", "Dates", { when: "has_end", after: "start_date" }),
      q("termination_days", "Notice to end early (days)", "number", "Dates", { min: 0, max: 365, defaultValue: "14" }),
      q("state", "Which state's law applies?", "choice", "Dates", { options: STATES, defaultValue: "NSW" }),
    ],
    clauses: [{ key: "con_relationship" }, { key: "con_work" }, { key: "con_pay" }, { key: "gst" }, { key: "con_insurance", when: "insurance" }, { key: "con_ip" }, { key: "confidentiality" }, { key: "con_termination" }, { key: "disputes" }, { key: "law" }, { key: "entire" }],
    reminders: [{ dateKey: "end_date", offsetDays: -14, title: "Contract ends in two weeks: {{title}}" }, { dateKey: "end_date", offsetDays: 0, title: "Contract ends: {{title}}" }],
  },
  {
    id: "std-quote-terms", name: "Quote terms", category: "Clients", description: "Short terms to send with a quote: how long it is valid, deposit, payment, changes and cancelling.",
    titlePattern: "Quote terms: {{business_name}}", partiesLine: "Terms for quotes from {{business_name}}",
    questions: [
      q("business_name", "Your business name", "text", "Basics", { defaultValue: "{{workspace_name}}" }),
      q("valid_days", "Days the quote is valid", "number", "Basics", { min: 1, max: 365, defaultValue: "30" }),
      q("gst", "Prices are", "choice", "Money", { options: GST, defaultValue: "plus" }),
      q("deposit", "Ask for a deposit?", "yesno", "Money", { options: YES_NO, defaultValue: "yes" }),
      q("deposit_percent", "Deposit (%)", "number", "Money", { when: "deposit", min: 1, max: 100, defaultValue: "25" }),
      q("payment_days", "Days to pay the rest", "number", "Money", { min: 0, max: 120, defaultValue: "7" }),
      q("variations", "Mention changes to the work?", "yesno", "Changes", { options: YES_NO, defaultValue: "yes" }),
      q("cancel_days", "Days notice to cancel", "number", "Changes", { min: 0, max: 365, defaultValue: "7" }),
      q("state", "Which state's law applies?", "choice", "Changes", { options: STATES, defaultValue: "NSW" }),
    ],
    clauses: [{ key: "quote_acceptance" }, { key: "quote_deposit", when: "deposit" }, { key: "quote_payment" }, { key: "quote_variations", when: "variations" }, { key: "quote_cancel" }, { key: "quote_consumer" }, { key: "law" }],
    reminders: [],
  },
  {
    id: "std-privacy", name: "Privacy notice", category: "Your business", description: "A plain privacy notice for your website: what you collect, why, who sees it and how to ask.",
    titlePattern: "Privacy notice: {{business_name}}", partiesLine: "Privacy notice for {{business_name}}, last updated {{today}}",
    questions: [
      q("business_name", "Your business name", "text", "Basics", { defaultValue: "{{workspace_name}}" }),
      q("contact_email", "Email for privacy questions", "email", "Basics"),
      q("collects", "What personal information do you collect?", "textarea", "Information", { defaultValue: "Your name, email address and phone number\nYour address for deliveries\nWhat you buy from us" }),
      q("uses", "What do you use it for?", "textarea", "Information", { defaultValue: "Provide our products and services\nSend receipts and updates about your order\nAnswer your questions" }),
      q("overseas", "Is any of it stored overseas?", "yesno", "Sharing", { options: YES_NO, defaultValue: "no" }),
      q("overseas_countries", "Which countries?", "text", "Sharing", { when: "overseas", placeholder: "the United States and Singapore" }),
      q("marketing", "Do you send marketing emails?", "yesno", "Sharing", { options: YES_NO, defaultValue: "no" }),
    ],
    clauses: [{ key: "priv_intro" }, { key: "priv_collect" }, { key: "priv_use" }, { key: "priv_disclose" }, { key: "priv_overseas", when: "overseas" }, { key: "priv_marketing", when: "marketing" }, { key: "priv_security" }, { key: "priv_access" }, { key: "priv_complaints" }],
    reminders: [{ dateKey: "today", offsetDays: 365, title: "Review your privacy notice: {{title}}" }],
  },
];
export const standardTemplate = (id: string) => STANDARD_TEMPLATES.find((t) => t.id === id) ?? null;

// ------------------------------------------------------------------------------------------- conditions
const TEST = /^\s*(not\s+)?([a-z][a-z0-9_]{0,39})\s*(?:(=|!=)\s*([A-Za-z0-9_ ]{1,40}?))?\s*$/;
export const truthy = (v: string | undefined) => !!v && v.trim() !== "" && v !== "no" && v !== "false" && v !== "0";

/** Tests a condition such as "has_end", "not auto_renew", "fee_type = hourly" or "nda_kind != mutual". Null when it can't be read. */
export function testCondition(cond: string, answers: Answers): boolean | null {
  const m = TEST.exec(cond);
  if (!m) return null;
  const [, not, key, op, value] = m;
  const v = (answers[key] ?? "").trim();
  let r: boolean;
  if (op === "=") r = v === value.trim();
  else if (op === "!=") r = v !== value.trim();
  else r = truthy(v);
  return not ? !r : r;
}
export const conditionOk = (cond: string) => TEST.test(cond);
export const conditionKeys = (cond: string) => { const m = TEST.exec(cond); return m ? [m[2]] : []; };

// ------------------------------------------------------------------------------------------- interview
/** The questions to ask now: those with no condition, or whose condition holds for the answers so far. */
export function visibleQuestions(def: Pick<ContractTemplateDef, "questions">, answers: Answers): Question[] {
  return def.questions.filter((x) => !x.when || testCondition(x.when, answers) === true);
}

export interface FillContext { workspaceName: string; today: string }
export function startingAnswers(def: Pick<ContractTemplateDef, "questions">, ctx: FillContext): Answers {
  const out: Answers = {};
  for (const x of def.questions) if (x.defaultValue != null) out[x.key] = x.defaultValue.replace("{{workspace_name}}", ctx.workspaceName).replace("{{today}}", ctx.today);
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validDate(v: string): boolean {
  if (!ISO.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
/** Australian Business Number checksum (subtract 1 from the first digit, weight, sum, divisible by 89). */
export function validAbn(v: string): boolean {
  const d = v.replace(/\s+/g, "");
  if (!/^\d{11}$/.test(d)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = d.split("").reduce((a, ch, i) => a + (Number(ch) - (i === 0 ? 1 : 0)) * w[i], 0);
  return sum % 89 === 0;
}
export const formatAbn = (v: string) => { const d = v.replace(/\s+/g, ""); return /^\d{11}$/.test(d) ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : v.trim(); };
export const parseMoney = (v: string) => { const n = Number(v.replace(/[$,\s]/g, "")); return v.trim() !== "" && Number.isFinite(n) ? n : null; };

/** Problems with the visible answers, by question key. Hidden questions are never checked. */
export function checkAnswers(def: Pick<ContractTemplateDef, "questions">, answers: Answers): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const x of visibleQuestions(def, answers)) {
    const v = (answers[x.key] ?? "").trim();
    if (!v) { if (x.required) errors[x.key] = x.type === "choice" || x.type === "yesno" ? "Choose an answer." : "Fill this in."; continue; }
    const max = x.type === "textarea" ? CONTRACT_LIMITS.longAnswer : CONTRACT_LIMITS.answer;
    if (v.length > max) { errors[x.key] = `Keep it under ${max} characters.`; continue; }
    if (x.type === "email" && !EMAIL.test(v)) errors[x.key] = "Enter an email address like name@example.com.";
    else if (x.type === "date" && !validDate(v)) errors[x.key] = "Choose a date.";
    else if (x.type === "abn" && !validAbn(v)) errors[x.key] = "That ABN doesn't look right. Check the 11 digits.";
    else if ((x.type === "choice" || x.type === "yesno") && !(x.options ?? []).some((o) => o.value === v)) errors[x.key] = "Choose one of the answers.";
    else if (x.type === "number" || x.type === "money") {
      const n = x.type === "money" ? parseMoney(v) : Number(v);
      if (n == null || !Number.isFinite(n) || (x.type === "number" && !Number.isInteger(n))) errors[x.key] = x.type === "money" ? "Enter an amount like 1500." : "Enter a whole number.";
      else if (x.min != null && n < x.min) errors[x.key] = `Use ${x.min} or more.`;
      else if (x.max != null && n > x.max) errors[x.key] = `Use ${x.max} or less.`;
    }
    if (!errors[x.key] && x.type === "date" && x.after) {
      const before = (answers[x.after] ?? "").trim();
      if (validDate(before) && v <= before) errors[x.key] = "This needs to be after the start date.";
    }
  }
  return errors;
}

// ------------------------------------------------------------------------------------------- assembling
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const longDate = (iso: string) => (validDate(iso) ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : iso);
const moneyText = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** How an answer reads in the document: dates in words, money with $, choices by label. */
export function displayValue(def: Pick<ContractTemplateDef, "questions">, key: string, answers: Answers, ctx: FillContext, title = ""): string | null {
  if (key === "workspace_name") return ctx.workspaceName;
  if (key === "today") return longDate(ctx.today);
  if (key === "title") return title;
  const x = def.questions.find((y) => y.key === key);
  const v = (answers[key] ?? "").trim();
  if (!x) return null;
  if (!v) return null;
  switch (x.type) {
    case "date": return longDate(v);
    case "money": { const n = parseMoney(v); return n == null ? v : moneyText(n); }
    case "abn": return formatAbn(v);
    case "choice": return x.key === "gst" ? ({ plus: "plus GST", includes: "including GST", none: "no GST" } as Record<string, string>)[v] ?? v : x.key === "state" ? (x.options ?? []).find((o) => o.value === v)?.label ?? v : (x.options ?? []).find((o) => o.value === v)?.label ?? v;
    default: return v;
  }
}

/** Checks a clause body: every [[if]] has an [[end]], every test can be read. Null when fine. */
export function checkClauseBody(body: string): string | null {
  let depth = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const m = /^\[\[if (.+)\]\]$/.exec(line);
    if (m) { if (!conditionOk(m[1])) return `This test can't be read: [[if ${m[1]}]]. Use a word like has_end, or fee_type = hourly.`; depth++; continue; }
    if (line === "[[end]]") { depth--; if (depth < 0) return "There is an [[end]] without an [[if]] before it."; continue; }
    const opens = [...line.matchAll(/\[\[if ([^\]]+)\]\]/g)];
    const ends = (line.match(/\[\[end\]\]/g) ?? []).length;
    if (opens.length !== ends) return "A test inside a line needs its [[end]] on the same line.";
    const bad = opens.find((o) => !conditionOk(o[1]));
    if (bad) return `This test can't be read: [[if ${bad[1]}]]. Use a word like has_end, or fee_type = hourly.`;
    if (/\[\[(?!if |end\]\])[^\]]*\]\]/.test(line)) return "Write each test as [[if word]] and close it with [[end]].";
  }
  return depth === 0 ? null : "Each [[if]] needs an [[end]] after it.";
}

/** Keeps the lines whose tests hold; inline [[if x]]text[[end]] works inside one line too. */
export function applyConditions(body: string, answers: Answers): string {
  const inline = (s: string) => s.replace(/\[\[if ([^\]]+)\]\]([\s\S]*?)\[\[end\]\]/g, (_, c: string, t: string) => (testCondition(c, answers) ? t : ""));
  const out: string[] = [];
  const stack: boolean[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const m = /^\[\[if (.+)\]\]$/.exec(line);
    if (m) { stack.push(testCondition(m[1], answers) === true); continue; }
    if (line === "[[end]]") { stack.pop(); continue; }
    if (stack.every(Boolean)) out.push(inline(raw));
  }
  return out.join("\n");
}

/** Trims line ends and collapses the blank lines a dropped condition leaves. */
function tidy(text: string): string {
  return text.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function fillText(def: Pick<ContractTemplateDef, "questions">, text: string, answers: Answers, ctx: FillContext, title = ""): string {
  return tidy(applyConditions(text, answers)).replace(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g, (_, k: string) => displayValue(def, k, answers, ctx, title) ?? BLANK);
}

export interface BuiltClause { key: string; version: number; heading: string; paragraphs: string[] }
export interface BuiltContract { title: string; partiesLine: string; clauses: BuiltClause[]; note: string }

/** Puts the contract together from the template, the effective clause texts and the answers. */
export function buildContract(def: ContractTemplateDef, clauseTexts: Map<string, ClauseText>, answers: Answers, ctx: FillContext): BuiltContract {
  const title = fillText(def, def.titlePattern, answers, ctx).replace(/\s+/g, " ").slice(0, 160);
  const partiesLine = fillText(def, def.partiesLine, answers, ctx, title).replace(/\s+/g, " ");
  const clauses: BuiltClause[] = [];
  for (const ref of def.clauses) {
    if (ref.when && testCondition(ref.when, answers) !== true) continue;
    const c = clauseTexts.get(ref.key);
    if (!c) continue;
    const paragraphs = fillText(def, c.body, answers, ctx, title).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (!paragraphs.length) continue;
    clauses.push({ key: c.key, version: c.version, heading: `${clauses.length + 1}. ${c.title}`, paragraphs });
  }
  return { title, partiesLine, clauses, note: CONTRACT_NOTE_LONG };
}

const mdEscape = (s: string) => s.replace(/([\\`*_[\]#<>|])/g, "\\$1");
export function contractMarkdown(b: BuiltContract): string {
  const parts = [`> **${CONTRACT_NOTE}** ${mdEscape(b.note.slice(CONTRACT_NOTE.length).trim())}`, "", mdEscape(b.partiesLine), ""];
  for (const c of b.clauses) {
    parts.push(`## ${mdEscape(c.heading)}`, "");
    for (const p of c.paragraphs) parts.push(p.split("\n").map((l) => (/^\d+\.\s/.test(l) ? l.replace(/^(\d+\.\s)(.*)$/, (_, n: string, r: string) => n + mdEscape(r)) : mdEscape(l))).join("\n"), "");
  }
  parts.push("## Signatures", "", `Signed for ${mdEscape(b.partiesLine.replace(/^Between /, "").split(" and ")[0] ?? "")}: ${BLANK}   Date: ${BLANK}`, "", `Signed for ${mdEscape(b.partiesLine.split(" and ")[1]?.replace(/ \(ABN.*$/, "") ?? "")}: ${BLANK}   Date: ${BLANK}`, "", `*${CONTRACT_NOTE}*`);
  return parts.join("\n");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
/** A clean A4 page for the PDF engine. Everything is escaped; nothing from answers becomes markup. */
export function contractHtml(b: BuiltContract, opts: { signatures?: boolean } = {}): string {
  const body = b.clauses.map((c) => `<section><h2>${esc(c.heading)}</h2>${c.paragraphs.map((p) => {
    const lines = p.split("\n");
    if (lines.every((l) => /^\d+\.\s/.test(l))) return `<ol>${lines.map((l) => `<li>${esc(l.replace(/^\d+\.\s/, ""))}</li>`).join("")}</ol>`;
    return `<p>${lines.map(esc).join("<br>")}</p>`;
  }).join("")}</section>`).join("");
  const parties = b.partiesLine.replace(/^Between /, "").split(" and ");
  const sig = opts.signatures === false || parties.length < 2 ? "" : `<section class="sig"><h2>Signatures</h2>${parties.map((p) => `<div class="line"><span>Signed for ${esc(p.replace(/ \(ABN.*$/, ""))}</span><span class="rule"></span><span>Date</span><span class="rule short"></span></div>`).join("")}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(b.title)}</title><style>
@page{size:A4;margin:22mm 20mm}body{font-family:Helvetica,Arial,sans-serif;color:#1f2933;font-size:10.5pt;line-height:1.55}
h1{font-size:18pt;margin:0 0 4px}h2{font-size:11.5pt;margin:18px 0 6px}p{margin:0 0 8px}ol{margin:0 0 8px 18px;padding:0}
.note{border:1px solid #d9e2ec;background:#f5f7fa;border-radius:6px;padding:8px 10px;font-size:9pt;margin:10px 0 14px}
.parties{color:#52606d;margin-bottom:6px}.sig .line{display:flex;gap:8px;align-items:flex-end;margin:22px 0}.rule{flex:1;border-bottom:1px solid #9aa5b1;height:16px}.rule.short{flex:0 0 110px}
footer{margin-top:24px;font-size:8.5pt;color:#7b8794}</style></head><body><h1>${esc(b.title)}</h1><div class="parties">${esc(b.partiesLine)}</div><div class="note"><strong>${esc(CONTRACT_NOTE)}</strong> ${esc(b.note.slice(CONTRACT_NOTE.length).trim())}</div>${body}${sig}<footer>${esc(CONTRACT_NOTE)}</footer></body></html>`;
}

// ------------------------------------------------------------------------------------------- reminders
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function addYears(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
export interface PlannedReminder { title: string; due: string; past: boolean }
/** The renewal and end date tasks this contract would add. Past dates are kept but marked, so the page can say so. */
export function plannedReminders(def: ContractTemplateDef, answers: Answers, ctx: FillContext, title: string): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  for (const r of def.reminders) {
    if (r.when && testCondition(r.when, answers) !== true) continue;
    const base = r.dateKey === "today" ? ctx.today : (answers[r.dateKey] ?? "").trim();
    if (!validDate(base)) continue;
    if (r.dateKey !== "today" && !visibleQuestions(def, answers).some((x) => x.key === r.dateKey)) continue;
    let due: string;
    if (r.offsetKey === "years") { const y = Number(answers.years); if (!Number.isInteger(y) || y < 1) continue; due = addYears(base, y); }
    else { const extra = r.offsetKey ? Number(answers[r.offsetKey]) : 0; if (r.offsetKey && !Number.isFinite(extra)) continue; due = addDays(base, r.offsetDays - (r.offsetKey ? extra : 0)); }
    const t = r.title.replace("{{title}}", title).slice(0, 200);
    if (!out.some((o) => o.due === due && o.title === t)) out.push({ title: t, due, past: due < ctx.today });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

// ------------------------------------------------------------------------------------------- workspace edits
export const CLAUSE_KEY = /^[a-z][a-z0-9_]{1,39}$/;
/** Placeholders in a body that the template's questions don't answer (they print as a blank line). */
export function unknownPlaceholders(def: Pick<ContractTemplateDef, "questions">, body: string): string[] {
  const known = new Set([...def.questions.map((x) => x.key), "workspace_name", "today", "title"]);
  return [...new Set([...body.matchAll(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g)].map((m) => m[1]))].filter((k) => !known.has(k));
}
export function checkClauseInput(input: { title: string; body: string }): string | null {
  if (!input.title.trim()) return "Give the clause a title.";
  if (input.title.trim().length > CONTRACT_LIMITS.clauseTitle) return `Keep the title under ${CONTRACT_LIMITS.clauseTitle} characters.`;
  if (!input.body.trim()) return "Write the clause text.";
  if (input.body.length > CONTRACT_LIMITS.clauseBody) return `Keep the clause under ${CONTRACT_LIMITS.clauseBody} characters.`;
  return checkClauseBody(input.body);
}
export const slugKey = (title: string) => `ws_${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "clause"}`;
