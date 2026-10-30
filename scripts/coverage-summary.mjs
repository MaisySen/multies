// Prints coverage/coverage-summary.json as a Markdown table (for the CI job summary).
import { readFileSync, existsSync } from "node:fs";

const file = "coverage/coverage-summary.json";
if (!existsSync(file)) {
  console.log("No coverage report was produced.");
  process.exit(0);
}
const { total } = JSON.parse(readFileSync(file, "utf8"));
const row = (k) => `| ${k} | ${total[k].pct}% | ${total[k].covered} / ${total[k].total} |`;
console.log(["### Test coverage", "", "| Metric | Covered | Count |", "| --- | --- | --- |", ...["lines", "statements", "functions", "branches"].map(row)].join("\n"));
