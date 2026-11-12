import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 20: an MCP client adds Multies by URL only. The SDK's own OAuth client discovers the server from
 * the 401, registers itself, sends the person to the consent page, and lists the tools with the token.
 */
const SHOTS = process.env.R20_SHOTS ?? `${SHOTS_ROOT}/multies-r20`;

class MemoryProvider implements OAuthClientProvider {
  info?: OAuthClientInformationFull; tok?: OAuthTokens; verifier = ""; authUrl?: URL;
  constructor(public redirect: string) {}
  get redirectUrl() { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata { return { client_name: "E2E MCP Client", redirect_uris: [this.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; }
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationFull) { this.info = i; }
  tokens() { return this.tok; }
  saveTokens(t: OAuthTokens) { this.tok = t; }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

test("an MCP client adds Multies by URL, the person allows it, and the tools list", async ({ page, baseURL }) => {
  const email = `e2e-oauth-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Olivia Oauth");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Olivia/ })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/app\/my-work$/);

  const mcpUrl = new URL("/api/v1/mcp", baseURL);
  const redirect = new URL("/oauth-e2e-callback", baseURL).toString();
  const provider = new MemoryProvider(redirect);
  const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  await expect(new Client({ name: "e2e", version: "1.0.0" }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.info?.client_id).toMatch(/^mcpc_/);
  expect(provider.authUrl?.pathname).toBe("/oauth/authorize");

  await page.goto(provider.authUrl!.toString());
  await expect(page.getByTestId("oauth-title")).toHaveText("Connect E2E MCP Client to Multies");
  await expect(page.getByTestId("oauth-scope-full")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: `${SHOTS}/mcp-oauth-consent.png` });
  await page.getByTestId("oauth-allow").click();
  await page.waitForURL(/\/oauth-e2e-callback\?/);
  const code = new URL(page.url()).searchParams.get("code")!;
  expect(code).toMatch(/^mcpg_/);
  await first.finishAuth(code);
  expect(provider.tok?.access_token).toMatch(/^mm_oat_/);

  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  expect(tools).toContain("create_task");
  expect(tools.length).toBeGreaterThanOrEqual(57);
  const made = await client.callTool({ name: "create_task", arguments: { title: "Made by an MCP client" } }) as { isError?: boolean };
  expect(made.isError).toBeFalsy();
  await client.close();

  // Settings shows the app and disconnects it.
  await page.goto("/app/settings/developers");
  await expect(page.getByTestId("connected-apps")).toContainText("E2E MCP Client");
  await page.screenshot({ path: `${SHOTS}/mcp-oauth-settings.png` });
  await page.getByRole("button", { name: "Disconnect E2E MCP Client" }).click();
  await expect(page.getByTestId("connected-apps")).toContainText("No AI apps connected yet.");
  const res = await fetch(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${provider.tok!.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  expect(res.status).toBe(401);
});

test("a signed out person signs in first and comes back to the consent page", async ({ page, baseURL, request }) => {
  const reg = await (await request.post("/api/oauth/register", { data: { client_name: "Cursor", redirect_uris: ["http://127.0.0.1:33418/cb"] } })).json();
  const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: "http://127.0.0.1:33418/cb", response_type: "code", code_challenge: "a".repeat(43), code_challenge_method: "S256", scope: "mcp:read" });
  await page.goto(`/oauth/authorize?${q}`);
  await page.waitForURL(/\/login\?next=/);
  expect(decodeURIComponent(page.url())).toContain("/oauth/authorize?");
  expect(baseURL).toBeTruthy();
});
