/**
 * R116: the lazy doors to the translate and read aloud chunk (lang-tools-r116.tsx). Hosts render these only while
 * TRANSLATE_R116 is on; the chunk loads the first time one shows. While it loads, the mail body shows as it always does.
 */
import { lazy, Suspense, type ComponentProps } from "react";
import { HtmlBody, TextBody } from "@/web/pages/app/mail/html-body";

const load = () => import("./lang-tools-r116");
const MailBody = lazy(() => load().then((m) => ({ default: m.MailBodyR116 })));
const ChatLang = lazy(() => load().then((m) => ({ default: m.ChatLangR116 })));
const DocLang = lazy(() => load().then((m) => ({ default: m.DocLangR116 })));
const Settings = lazy(() => load().then((m) => ({ default: m.TranslateSettingsR116 })));

export function MailBodyLazy(p: ComponentProps<typeof MailBody>) {
  return <Suspense fallback={p.html ? <HtmlBody html={p.html} /> : <TextBody text={p.text} />}><MailBody {...p} /></Suspense>;
}
export const ChatLangLazy = (p: ComponentProps<typeof ChatLang>) => <Suspense fallback={null}><ChatLang {...p} /></Suspense>;
export const DocLangLazy = (p: ComponentProps<typeof DocLang>) => <Suspense fallback={null}><DocLang {...p} /></Suspense>;
export const TranslateSettingsLazy = () => <Suspense fallback={null}><Settings /></Suspense>;
