// Writes a 1,000 row CSV like an Asana export (sections, parents, tags, assignee emails, quoted notes).
// node tests/fixtures/work-import/generate-1000.mjs > /tmp/import-1000.csv
export function makeCsv(n = 1000) {
  const lines = ["Task ID,Name,Section/Column,Assignee Email,Due Date,Tags,Notes,Parent task,Completed At"];
  for (let i = 0; i < n; i++) {
    const parent = i % 5 ? `Task ${i - (i % 5)}` : "";
    lines.push(`${1300000 + i},Task ${i},${["To do", "Doing", "Done"][i % 3]},owner@acme.io,2026-11-${String((i % 28) + 1).padStart(2, "0")},"tag${i % 7},all","Note for ${i}, with a comma",${parent},${i % 3 === 2 ? "2026-10-20" : ""}`);
  }
  return lines.join("\n");
}
if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(makeCsv(Number(process.argv[2] ?? 1000)));
