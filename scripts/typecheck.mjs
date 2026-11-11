#!/usr/bin/env node
// npm run typecheck. tsc needs about 5.3 GB on this codebase (docs/testing.md), more than Node's default heap, so it
// runs with a 6 GB heap that fits the 7 GB CI runner. QUAL1: a heap size already in NODE_OPTIONS wins, so a machine
// that needs more can raise it without editing this file (a flag on the node command line would override it). Node
// takes the flag with a hyphen or an underscore between each pair of words, so both spellings count.
// Extra arguments go to tsc, for example: npm run typecheck -- --extendedDiagnostics
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const project = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const heap = /--max[-_]old[-_]space[-_]size=\d+/.test(process.env.NODE_OPTIONS ?? "") ? [] : ["--max-old-space-size=6144"];
const run = spawnSync(process.execPath, [...heap, tsc, "--noEmit", "-p", project, ...process.argv.slice(2)], { stdio: "inherit" });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
