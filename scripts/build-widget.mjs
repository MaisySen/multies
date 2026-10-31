// R119: writes src/server/routes/widget-script.ts from scripts/widget-src.js. Run: node scripts/build-widget.mjs
import { readFileSync, writeFileSync } from "node:fs";
const src = readFileSync(new URL("./widget-src.js", import.meta.url), "utf8");
const head = "/**\n * R119: the website chat script served at /widget.js. Generated from scripts/widget-src.js by scripts/build-widget.mjs\n * (a unit test checks the two match). Plain JavaScript, no third party calls, the panel is built only on first open.\n */\n";
writeFileSync(new URL("../src/server/routes/widget-script.ts", import.meta.url), `${head}export const WIDGET_JS: string = ${JSON.stringify(src)};\n`);
