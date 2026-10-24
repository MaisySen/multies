// Builds every Multies brand asset from the SVG sources in this folder.
// Run from the app root: node brand/build.mjs
// The wordmark is Inter SemiBold (SIL OFL 1.1), outlined to paths so it renders the same everywhere.
import sharp from "sharp";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const BLUE = "#0071E3";
const INK = "#1D1D1F";
const PAPER = "#F5F5F7";
const WORDMARK = "M2.93 0V-29.1H10.79L16.32 -14.07Q16.6 -13.24 16.96 -11.93Q17.32 -10.61 17.7 -9.09Q18.08 -7.56 18.42 -6.11Q18.76 -4.66 19 -3.54H17.94Q18.19 -4.62 18.52 -6.06Q18.86 -7.5 19.24 -9.03Q19.62 -10.56 19.99 -11.89Q20.35 -13.23 20.63 -14.07L26.09 -29.1H33.97V0H28.76V-14.69Q28.76 -15.62 28.78 -16.95Q28.81 -18.28 28.85 -19.81Q28.89 -21.33 28.92 -22.88Q28.96 -24.44 28.97 -25.83H29.34Q28.95 -24.3 28.49 -22.69Q28.04 -21.07 27.59 -19.56Q27.14 -18.04 26.73 -16.78Q26.33 -15.52 26.04 -14.69L20.66 0H16.23L10.77 -14.69Q10.48 -15.5 10.09 -16.75Q9.69 -17.99 9.24 -19.49Q8.78 -21 8.31 -22.62Q7.85 -24.25 7.4 -25.83H7.83Q7.86 -24.53 7.89 -23Q7.93 -21.47 7.96 -19.93Q8 -18.38 8.03 -17.02Q8.06 -15.66 8.06 -14.69V0Z M46.59 0.27Q44.34 0.27 42.66 -0.69Q40.97 -1.65 40.04 -3.49Q39.11 -5.33 39.11 -7.95V-21.84H44.18V-8.73Q44.18 -6.54 45.33 -5.29Q46.47 -4.04 48.47 -4.04Q49.82 -4.04 50.87 -4.63Q51.92 -5.22 52.52 -6.35Q53.12 -7.47 53.12 -9.05V-21.84H58.21V0H53.39L53.33 -5.4H53.71Q52.8 -2.54 51 -1.13Q49.21 0.27 46.59 0.27Z M68.2 -29.1V0H63.12V-29.1Z M83.21 -21.84V-17.86H70.81V-21.84ZM73.9 -27.03H78.98V-6.15Q78.98 -4.97 79.49 -4.41Q80 -3.86 81.17 -3.86Q81.5 -3.86 82.08 -3.94Q82.65 -4.02 83 -4.1L83.8 -0.18Q82.97 0.08 82.1 0.19Q81.22 0.29 80.41 0.29Q77.27 0.29 75.59 -1.27Q73.9 -2.83 73.9 -5.71Z M86.75 0V-21.84H91.83V0ZM89.29 -24.93Q88.08 -24.93 87.21 -25.74Q86.34 -26.56 86.34 -27.7Q86.34 -28.87 87.21 -29.68Q88.08 -30.49 89.29 -30.49Q90.52 -30.49 91.39 -29.68Q92.26 -28.87 92.26 -27.71Q92.26 -26.56 91.39 -25.74Q90.52 -24.93 89.29 -24.93Z M106.38 0.44Q103.1 0.44 100.72 -0.94Q98.34 -2.32 97.06 -4.84Q95.78 -7.36 95.78 -10.78Q95.78 -14.15 97.04 -16.7Q98.31 -19.25 100.62 -20.68Q102.93 -22.11 106.05 -22.11Q108.05 -22.11 109.86 -21.46Q111.66 -20.82 113.05 -19.47Q114.45 -18.13 115.25 -16.05Q116.05 -13.97 116.05 -11.09V-9.5H98.18V-12.95H113.51L111.14 -11.92Q111.14 -13.78 110.57 -15.17Q110 -16.57 108.87 -17.35Q107.75 -18.13 106.08 -18.13Q104.41 -18.13 103.23 -17.34Q102.06 -16.54 101.44 -15.22Q100.83 -13.9 100.83 -12.29V-9.9Q100.83 -7.83 101.53 -6.41Q102.23 -4.99 103.5 -4.26Q104.77 -3.54 106.45 -3.54Q107.56 -3.54 108.47 -3.86Q109.38 -4.18 110.04 -4.81Q110.7 -5.44 111.04 -6.37L115.71 -5.41Q115.19 -3.66 113.91 -2.34Q112.64 -1.02 110.73 -0.29Q108.82 0.44 106.38 0.44Z M128.17 0.44Q125.66 0.44 123.72 -0.28Q121.79 -1 120.55 -2.39Q119.32 -3.77 118.93 -5.74L123.69 -6.64Q124.13 -5.02 125.27 -4.23Q126.42 -3.45 128.27 -3.45Q130.15 -3.45 131.25 -4.2Q132.35 -4.95 132.35 -6.05Q132.35 -7 131.62 -7.62Q130.9 -8.23 129.4 -8.55L125.68 -9.36Q122.59 -10.02 121.06 -11.55Q119.54 -13.07 119.54 -15.48Q119.54 -17.5 120.66 -18.99Q121.77 -20.47 123.75 -21.29Q125.73 -22.11 128.34 -22.11Q130.82 -22.11 132.61 -21.41Q134.4 -20.71 135.5 -19.44Q136.61 -18.18 137.04 -16.48L132.51 -15.59Q132.13 -16.73 131.16 -17.52Q130.18 -18.31 128.41 -18.31Q126.8 -18.31 125.71 -17.61Q124.63 -16.9 124.63 -15.78Q124.63 -14.83 125.34 -14.21Q126.06 -13.58 127.72 -13.22L131.44 -12.44Q134.54 -11.78 136.05 -10.31Q137.56 -8.85 137.56 -6.54Q137.56 -4.47 136.36 -2.9Q135.16 -1.33 133.05 -0.44Q130.93 0.44 128.17 0.44Z";

// The mark (concept A3, chosen by the owner on 24 Oct): a chunky rounded M with an orange spark above it.
// Geometry lives on a 100 unit grid. The M is one round-capped stroke; the spark is a circle.
// SMALL is the favicon cut: a slightly heavier M and a larger spark, so the spark survives at 16 px.
const SPARK = "#FF6A1A";
const TILE = "#1D1D1F";
const M_POINTS = "20,79 20,39 50,67 80,39 80,79";
const glyph = (ink = INK, spark = SPARK, small = false) =>
  `<polyline points="${M_POINTS}" fill="none" stroke="${ink}" stroke-width="${small ? 23 : 21}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<circle cx="50" cy="${small ? 17 : 20}" r="${small ? 14 : 11}" fill="${spark}"/>`;
// The drawn mark spans x 9.5 to 90.5 and y 9 to 89.5 (small: 3 to 90.5); centre it on (50, 50).
const centred = (body, small = false) => `<g transform="translate(0 ${small ? 3.25 : 0.75})">${body}</g>`;
const tile = (fill = TILE, size = 100) => `<rect width="${size}" height="${size}" rx="${size * 0.225}" fill="${fill}"/>`;
const svg = (vb, body, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${extra}>${body}</svg>\n`;
// The mark on its tile: the M at 62 percent of the tile, like an iOS app icon.
const onTile = (small = false, fill = TILE) =>
  tile(fill) + `<g transform="translate(50 50) scale(${small ? 0.66 : 0.62}) translate(-50 -50)">${centred(glyph("#fff", SPARK, small), small)}</g>`;

const markColour = svg("0 0 100 100", centred(glyph()));
const markDark = svg("0 0 100 100", centred(glyph("#fff")));
const markMono = svg("0 0 100 100", centred(glyph("currentColor", "currentColor")));
const markTile = svg("0 0 100 100", onTile());

// Lockup: the mark at 40 units tall, 12 unit gap, the wordmark at 40 units with its cap height centred on the mark.
const W = 192, H = 49;
const lockupMark = (ink, spark) => `<g transform="translate(0 4.5) scale(0.4938) translate(-9.5 -8.25)">${centred(glyph(ink, spark))}</g>`;
const lockup = (text, ink, spark = SPARK) => svg(`0 0 ${W} ${H}`,
  `${lockupMark(ink, spark)}<path transform="translate(52 39.05)" fill="${text}" d="${WORDMARK}"/>`);
const logoLight = lockup(INK, INK);
const logoDark = lockup(PAPER, "#fff");
const logoMono = lockup("currentColor", "currentColor", "currentColor");

// Full-bleed square for platforms that round corners themselves (iOS, PWA). scale keeps the M in the safe zone.
const square = (size, { bg = TILE, scale = 0.62, fg = "#fff", spark = SPARK, alphaBg = false, small = false } = {}) => {
  const s = size / 100;
  const g = `<g transform="scale(${s}) translate(50 50) scale(${scale}) translate(-50 -50)">${centred(glyph(fg, spark, small), small)}</g>`;
  return svg(`0 0 ${size} ${size}`, (alphaBg ? "" : `<rect width="${size}" height="${size}" fill="${bg}"/>`) + g);
};

const out = (p, data) => { const f = join(here, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, data); return f; };
const png = async (svgText, file, size, flatten = false) => {
  let img = sharp(Buffer.from(svgText), { density: 384 }).resize(size, size);
  if (flatten) img = img.flatten({ background: TILE });
  out(file, await img.png({ compressionLevel: 9 }).toBuffer());
};

out("logo-mark.svg", markColour);
out("logo-mark-dark.svg", markDark);
out("logo-mark-mono.svg", markMono);
out("logo-mark-tile.svg", markTile);
out("logo-light.svg", logoLight);
out("logo-dark.svg", logoDark);
out("logo-mono.svg", logoMono);

// Web: favicons, touch icon and manifest icons. The favicon uses the small cut so the spark stays visible.
const favicon = svg("0 0 100 100", onTile(true));
await png(favicon, "web/favicon-16.png", 16);
await png(favicon, "web/favicon-32.png", 32);
await png(favicon, "web/favicon-48.png", 48);
await png(square(180, { scale: 0.64 }), "web/apple-touch-icon.png", 180, true);
await png(square(192), "web/icon-192.png", 192);
await png(square(512), "web/icon-512.png", 512);
await png(square(512, { scale: 0.52 }), "web/icon-maskable-512.png", 512, true);
out("web/favicon.svg", favicon);
// Email header: the light lockup as a PNG, since many mail apps do not show SVG.
out("web/email-logo.png", await sharp(Buffer.from(logoLight), { density: 600 }).resize({ width: 384 }).png({ compressionLevel: 9 }).toBuffer());

// favicon.ico holding the 16, 32 and 48 PNGs (PNG-in-ICO, supported by every current browser).
const icoParts = ["web/favicon-16.png", "web/favicon-32.png", "web/favicon-48.png"].map((p) => readFileSync(join(here, p)));
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoParts.length, 4);
let offset = 6 + 16 * icoParts.length;
const dir = icoParts.map((buf, i) => {
  const e = Buffer.alloc(16); const size = [16, 32, 48][i];
  e.writeUInt8(size, 0); e.writeUInt8(size, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
  offset += buf.length; return e;
});
out("web/favicon.ico", Buffer.concat([header, ...dir, ...icoParts]));

// Mobile sources (Expo). Android adaptive layers are 1024 with the M inside the central 66 percent.
await png(square(1024, { scale: 0.62 }), "mobile/icon.png", 1024, true);
await png(square(1024, { scale: 0.42, alphaBg: true }), "mobile/adaptive-foreground.png", 1024);
await png(svg("0 0 1024 1024", `<rect width="1024" height="1024" fill="${TILE}"/>`), "mobile/adaptive-background.png", 1024);
await png(square(1024, { scale: 0.42, alphaBg: true, spark: "#fff" }), "mobile/adaptive-monochrome.png", 1024);
await png(svg("0 0 100 100", onTile()), "mobile/splash-icon.png", 1024);
await png(square(96, { scale: 0.86, alphaBg: true, spark: "#fff", small: true }), "mobile/notification-icon.png", 96);

// Open Graph card, 1200 by 630.
const og = svg("0 0 1200 630", `<rect width="1200" height="630" fill="${PAPER}"/>
<g transform="translate(120 110) scale(2)">${logoLight.replace(/<\/?svg[^>]*>/g, "")}</g>
<text x="120" y="360" font-family="Inter, Helvetica, Arial, sans-serif" font-size="56" font-weight="600" fill="${INK}" letter-spacing="-1">Email on your own domain,</text>
<text x="120" y="430" font-family="Inter, Helvetica, Arial, sans-serif" font-size="56" font-weight="600" fill="${INK}" letter-spacing="-1">with tasks, chat and agents.</text>
<text x="120" y="520" font-family="Inter, Helvetica, Arial, sans-serif" font-size="30" fill="#6E6E73">Free for small businesses and startups.</text>`);
out("og-image.svg", og);
out("web/og-image.png", await sharp(Buffer.from(og), { density: 144 }).resize(1200, 630).png({ compressionLevel: 9 }).toBuffer());

// Large renders for docs and decks.
out("logo-light.png", await sharp(Buffer.from(logoLight), { density: 1200 }).resize({ width: 1200 }).png().toBuffer());
out("logo-dark.png", await sharp(Buffer.from(logoDark), { density: 1200 }).resize({ width: 1200 }).png().toBuffer());

// Copy the web set into public/.
for (const f of ["favicon.svg", "favicon.ico", "favicon-16.png", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "og-image.png", "email-logo.png"]) {
  writeFileSync(join(root, "public", f), readFileSync(join(here, "web", f)));
}
console.log("brand assets written");
