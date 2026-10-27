
import Database from "better-sqlite3"; import { readdirSync, readFileSync, rmSync } from "node:fs";
const [dir, path] = process.argv.slice(2); rmSync(path, { force: true }); rmSync(path + "-wal", { force: true }); rmSync(path + "-shm", { force: true });
const db = new Database(path);
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  for (const stmt of readFileSync(dir + "/" + f, "utf8").split("--> statement-breakpoint")) { const s = stmt.trim(); if (s) { try { db.exec(s); } catch (e) { console.log("ERR", f, e.message.slice(0, 100)); } } }
}
console.log("migrated");
