// R29: run the D1 read retry check under wrangler dev (local workerd + local D1), print the result, stop the server.
import { spawn } from "node:child_process";
import { mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.D1CHECK_PORT || 8890);
const state = mkdtempSync(join(tmpdir(), "d1check-"));
const log = openSync(join(state, "wrangler.log"), "w");
const child = spawn("npx", ["wrangler", "dev", "--local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state, "--inspector-port", String(port + 1)], { cwd: dir, stdio: ["ignore", log, log], detached: true });
const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
process.on("exit", stop);
let out = null;
for (let i = 0; i < 90 && !out; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok || res.status === 500) out = await res.text(); } catch { /* not up yet */ }
}
stop();
if (!out) { console.error("wrangler dev did not answer; log in", join(state, "wrangler.log")); process.exit(2); }
console.log(out);
let j; try { j = JSON.parse(out); } catch { process.exit(1); }
process.exit(j.ok ? 0 : 1);
