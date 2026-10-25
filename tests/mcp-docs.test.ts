import { it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** docs/MCP.md lists every tool the MCP server registers (it once said 22 when there were 58). */
it("documents every MCP tool", () => {
  const src = readFileSync("src/server/routes/mcp-server.ts", "utf8");
  const doc = readFileSync("docs/MCP.md", "utf8");
  const names = [...src.matchAll(/registerTool\("(\w+)"/g)].map((m) => m[1]);
  expect(names.length).toBeGreaterThanOrEqual(58);
  const missing = names.filter((n) => !doc.includes(`\`${n}\``));
  expect(missing).toEqual([]);
  expect(doc).toContain(`Tools: ${names.length}`);
});
