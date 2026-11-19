/** Private, explicitly opted-in staging diagnostics only. Never use this receipt as authority. */
export function privateConsoleVersion(env: Record<string, unknown>, request: Request, configuredOrigin: string): string | undefined {
  const value = env.PRIVATE_CONSOLE_PROOF_ORIGIN;
  if (typeof value !== "string" || !value.startsWith("https://") || value !== configuredOrigin) return;
  const target = new URL(request.url);
  if (target.origin !== value || target.pathname !== "/api/account/providers" || target.search || request.method !== "GET") return;
  const metadata = env.CF_VERSION_METADATA;
  if (typeof metadata !== "object" || metadata === null || !("id" in metadata)) return;
  return typeof metadata.id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(metadata.id)
    ? metadata.id : undefined;
}

export function attachPrivateConsoleVersion(response: Response, build: string | undefined): Response {
  if (!build) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Multies-Stage-Version", build);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
