/**
 * R36: split a plain text mail into what the sender wrote and the quoted tail (the earlier
 * message their client pasted below), so the thread can fold the tail behind "Show quoted text".
 * The tail starts at the first "On ... wrote:" line, a "-----Original Message-----" line, a
 * "From: ... Sent: ..." block, or the first run of lines starting with ">" that lasts to the end.
 */
export function splitQuoted(text: string | null | undefined): { body: string; quoted: string | null } {
  const t = (text ?? "").replace(/\r\n/g, "\n");
  const lines = t.split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^On .{4,200}wrote:$/i.test(l) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l) || (/^From: /.test(l) && /^(Sent|Date): /.test((lines[i + 1] ?? "").trim()))) { cut = i; break; }
    if (l.startsWith(">") && lines.slice(i).every((x) => x.trim() === "" || x.trim().startsWith(">"))) { cut = i; break; }
  }
  if (cut <= 0) return { body: t.trim(), quoted: null };
  const body = lines.slice(0, cut).join("\n").trim();
  const quoted = lines.slice(cut).map((x) => x.replace(/^\s*> ?/, "")).join("\n").trim();
  return body ? { body, quoted: quoted || null } : { body: t.trim(), quoted: null };
}

/** One line preview of a collapsed message: the first words the sender wrote. */
export function previewLine(text: string | null | undefined, max = 90): string {
  const s = splitQuoted(text).body.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s;
}

/** R36: who Reply all copies: everyone on To and Cc except the person replied to and my own addresses. */
export function replyAllCc(m: { to: { address: string }[]; cc: { address: string }[] }, replyAddress: string, mine: (string | null | undefined)[]): string[] {
  const skip = new Set([replyAddress, ...mine].filter(Boolean).map((a) => String(a).toLowerCase()));
  const out: string[] = [];
  for (const a of [...m.to, ...m.cc]) {
    const k = a.address.toLowerCase();
    if (!skip.has(k)) { skip.add(k); out.push(a.address); }
  }
  return out;
}
