import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { IconImageOff } from "@/web/components/ui/icon";

/**
 * Renders untrusted email HTML: sanitized with DOMPurify, inside a sandboxed iframe
 * that cannot run scripts, under a CSP that blocks remote images until the reader
 * opts in (remote images are how senders track opens).
 */
export function HtmlBody({ html }: { html: string }) {
  const [images, setImages] = useState(false);
  const [height, setHeight] = useState(200);
  const ref = useRef<HTMLIFrameElement>(null);
  // impeccable-disable-next-line broken-image (a regex that detects remote images, not an <img> tag)
  const hasRemote = /<img[^>]+src=["']?https?:/i.test(html) || /url\(\s*['"]?https?:/i.test(html);
  const doc = useMemo(() => {
    const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false, FORBID_TAGS: ["style", "form", "input", "button"], ADD_ATTR: ["target"] });
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: cid: ${images ? "https:" : ""}; font-src data:;`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">
      <style>html,body{margin:0;padding:0;background:#fff;color:#111;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;word-wrap:break-word}
      body{padding:20px} img{max-width:100%;height:auto} a{color:#4f46e5} table{max-width:100%!important} pre{white-space:pre-wrap}</style></head><body>${clean}</body></html>`;
  }, [html, images]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const b = el.contentDocument?.body;
      if (b) setHeight(Math.min(Math.max(b.scrollHeight + 4, 120), 6000));
    };
    el.addEventListener("load", measure);
    const t = setInterval(measure, 500);
    setTimeout(() => clearInterval(t), 4000);
    return () => { el.removeEventListener("load", measure); clearInterval(t); };
  }, [doc]);

  return (
    <div>
      {hasRemote && !images && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-line bg-fill/60 px-3 py-2 text-xs text-muted">
          <span className="flex items-center gap-2"><IconImageOff className="h-3.5 w-3.5" />Remote images are hidden to protect your privacy.</span>
          <button className="font-medium text-fg hover:underline" onClick={() => setImages(true)}>Show images</button>
        </div>
      )}
      <iframe ref={ref} title="Message content" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} style={{ height }} className="w-full rounded-lg border border-line bg-white" />
    </div>
  );
}

/** Plain-text body with links and collapsible quoted text. */
export function TextBody({ text }: { text: string }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const lines = text.split(/\r?\n/);
  // nosemgrep: regex_dos (runs on one trimmed line of a message the reader opened, anchored at both ends)
  const firstQuote = lines.findIndex((l, i) => l.startsWith(">") || (/^On .+wrote:$/.test(l.trim()) && lines[i + 1]?.startsWith(">")));
  const main = firstQuote > 0 ? lines.slice(0, firstQuote).join("\n").trimEnd() : text;
  const quoted = firstQuote > 0 ? lines.slice(firstQuote).join("\n") : "";
  return (
    <div className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-fg/90">
      <Linkified text={main} />
      {quoted && (
        <>
          <button className="mt-3 block rounded-md border border-line px-2 text-xs leading-5 text-muted hover:text-fg" onClick={() => setShowQuoted((s) => !s)} aria-expanded={showQuoted} aria-label="Toggle quoted text">•••</button>
          {showQuoted && <div className="mt-3 border-l-2 border-line pl-3 text-muted"><Linkified text={quoted} /></div>}
        </>
      )}
    </div>
  );
}

function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g);
  return <>{parts.map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-hover underline decoration-brand/40 underline-offset-2 hover:decoration-brand">{p}</a> : p))}</>;
}
