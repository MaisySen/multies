/**
 * R37: real example calls and answers for the MCP tools, captured from a local Multies server with example
 * seed data by tests/capture-mcp-examples-r37.test.ts. One source for the docs page (/api/mcp-tools),
 * /developers/mcp.md and llms-full.txt (scripts/build-llms.ts). No server imports here, so the build
 * script can read it. tests/mcp-scoped-tools-r37.test.ts fails if fewer than 40 tools have one.
 */
import captured from "./mcp-examples.generated.json";

type Example = { arguments: Record<string, unknown>; result: unknown };
export const CAPTURED: Record<string, Example> = (captured as { examples: Record<string, Example> }).examples;
export const CAPTURED_AT: string = (captured as { capturedAt: string }).capturedAt;

/** The captured examples as Markdown. Long answers are cut so the files stay readable. */
export function capturedExamplesMarkdown(maxResultChars = 900): string[] {
  const out = [
    "## Example calls with real results",
    "",
    `These are real answers from a Multies server with example data (captured ${CAPTURED_AT}). Ids are made stable, secrets are hidden and long lists are cut to 3 items. Your ids and data will differ.`,
    "",
  ];
  for (const [name, ex] of Object.entries(CAPTURED)) {
    let result = JSON.stringify(ex.result, null, 2);
    if (result.length > maxResultChars) result = `${result.slice(0, maxResultChars)}\n... (cut)`;
    out.push(`### ${name}`, "", "Call:", "", "```json", JSON.stringify({ name, arguments: ex.arguments }), "```", "", "Result:", "", "```json", result, "```", "");
  }
  return out;
}

/** The docs section on hiding the tools a key can't use. One copy for the .md and llms-full. */
export const SCOPED_TOOL_LIST_MD = [
  "## Show only the tools a key can use",
  "",
  "A key with limited scopes can hide the tools it can't use, so an agent's tool list stays short and every tool it sees will work.",
  "",
  "- Per key: turn on \"Show only the tools this key can use\" when you create or edit a key in Settings, Developers. It is on by default for new keys with limited scopes and off for keys made before it existed. Full access keys always see every tool. Over the API: `showOnlyUsableTools: true` on `POST` or `PATCH /api/developer/keys`.",
  "- Per connection: add `?tools=scoped` to the MCP URL (`https://multies.si/api/v1/mcp?tools=scoped`), or send the header `X-Multies-Tools: scoped`. `?tools=all` shows every tool even when the key hides them. This works for API keys and for OAuth sign-ins: a read only sign-in then sees only read tools.",
  "- A hidden tool is only hidden from `tools/list`. Calling it by name still gets the same `insufficient_scope` (or `read_only_key`) answer as before.",
  "- To see a key's list without an MCP client: `GET https://multies.si/api/mcp-tools?view=key` with `Authorization: Bearer <key>`, or preview any scopes with `GET https://multies.si/api/mcp-tools?scope=mail:read+tasks:write`.",
  "",
];
