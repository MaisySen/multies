import { it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/** docs/MCP.md lists every tool the MCP server registers (it once said 22 when there were 58). */
it("documents every MCP tool", () => {
  // R31: every routes file, since some areas register their MCP tools next to their routes.
  const dir = "src/server/routes";
  const src = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(`${dir}/${f}`, "utf8")).join("\n");
  const doc = readFileSync("docs/MCP.md", "utf8");
  const names = [...src.matchAll(/registerTool\("(\w+)"/g)].map((m) => m[1]);
  expect(names.length).toBeGreaterThanOrEqual(58);
  const missing = names.filter((n) => !doc.includes(`\`${n}\``));
  expect(missing).toEqual([]);
  expect(doc).toContain(`Tools: ${names.length}`);
});
