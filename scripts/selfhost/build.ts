/** Bundles the self-host tools into dist/selfhost/ for the Docker image (dependencies stay external). */
import { build } from "esbuild";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const entries: Record<string, string> = {
  "mail-bridge": "scripts/selfhost/mail-bridge.ts",
  "db-tool": "scripts/selfhost/db-tool.ts",
  "selfhost-stalwart": "scripts/selfhost/stalwart.ts",
  "stalwart-setup": "scripts/stalwart-setup.ts",
};
for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(root, `dist/selfhost/${name}.js`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    alias: { "@": path.join(root, "src") },
    logLevel: "warning",
  });
}
console.log(`self-host tools built: dist/selfhost/{${Object.keys(entries).join(",")}}.js`);
