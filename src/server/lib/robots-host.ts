/**
 * R81B: the *.workers.dev address of production serves the same pages as multies.si. Responses there carry
 * X-Robots-Tag so search engines list multies.si only. robots.txt there stays the production one, because the
 * deploy checks read it on that address.
 */
export function isWorkersDevHost(url: string): boolean {
  return new URL(url).hostname.endsWith(".workers.dev");
}

export function withRobotsHeader(res: Response): Response {
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  out.headers.set("x-robots-tag", "noindex, nofollow");
  return out;
}
