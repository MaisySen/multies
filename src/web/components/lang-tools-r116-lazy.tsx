/**
 * R116: the lazy doors to the translate and read aloud chunk (lang-tools-r116.tsx), made with lazyPage. Hosts render
 * these only while TRANSLATE_R116 is on; the chunk loads the first time one shows. While it loads, or if it cannot
 * load, the mail body shows exactly as it always does.
 */
import { Suspense, useEffect, useState, type ComponentProps } from "react";
import { lazyPage } from "./lazy-page";
import { HtmlBody, TextBody } from "@/web/pages/app/mail/html-body";

const load = () => import("./lang-tools-r116");
const MailBody = lazyPage(load, "MailBodyR116", { quiet: true });
const ChatLang = lazyPage(load, "ChatLangR116", { quiet: true });
const DocLang = lazyPage(load, "DocLangR116", { quiet: true });
const Settings = lazyPage(load, "TranslateSettingsR116", { quiet: true });

export function MailBodyLazy(p: ComponentProps<typeof MailBody>) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { load().catch(() => setFailed(true)); }, []);
  const plain = p.html ? <HtmlBody html={p.html} /> : <TextBody text={p.text} />;
  return failed ? plain : <Suspense fallback={plain}><MailBody {...p} /></Suspense>;
}
export const ChatLangLazy = (p: ComponentProps<typeof ChatLang>) => <Suspense fallback={null}><ChatLang {...p} /></Suspense>;
export const DocLangLazy = (p: ComponentProps<typeof DocLang>) => <Suspense fallback={null}><DocLang {...p} /></Suspense>;
export const TranslateSettingsLazy = () => <Suspense fallback={null}><Settings /></Suspense>;
