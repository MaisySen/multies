type ReplyMedia = "json" | "events";

/** Prefer bounded JSON when accepted; never send JSON to a client that accepted only an event stream. */
export function mcpPostReply(accept: string | undefined): ReplyMedia | null {
  if (!accept?.trim()) return "json";
  const offers = accept.toLowerCase().split(",").map(offer => {
    const [media, ...params] = offer.split(";").map(p => p.trim());
    const weight = params.find(p => /^q\s*=/.test(p));
    const value = weight === undefined ? "1" : weight.slice(weight.indexOf("=") + 1).trim();
    return {media, q:/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0};
  });
  const preference = (media: string) => {
    const type=media.split("/")[0];
    for (const range of [media, type+"/*", "*/*"]) {
      const matches=offers.filter(o=>o.media===range);
      if (matches.length) return Math.max(...matches.map(o=>o.q));
    }
    return 0;
  };
  const json=preference("application/json"), events=preference("text/event-stream");
  if (json>0 && json>=events) return "json";
  return events>0 ? "events" : null;
}
