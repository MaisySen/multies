import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // mobile/ is the Expo app, merged from the mobile branch, with its own lint and tests.
  // deploy/auth0: scripts that run inside the identity provider (its globals, not ours); tests/auth0-legacy-migration.test.ts runs them.
  // Third party bundles copied in as they ship (THIRD_PARTY_NOTICES.md): public/vendor (libarchive worker, qpdf, and the
  // API reference renderer that scripts/restore-vendor.mjs rebuilds there) and the libarchive loader under convert/vendor.
  // They are minified upstream code, not ours to restyle; their own .d.ts files stay linted.
  { ignores: ["dist", ".wrangler", "node_modules", "drizzle", "coverage", "src/server/db/migrations.generated.ts", "mobile", "deploy/auth0", "public/vendor", "src/web/lib/convert/vendor/**/*.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // caughtErrorsIgnorePattern: scripts/widget-src.js runs on customer sites in old browsers too, so it keeps
      // catch (_e) rather than the newer bare catch {}.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  // R39: CommonJS helper scripts (the e2e shot scripts under e2e/support) load with require by design.
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // R34 (MB-192): the browser's own confirm, prompt and alert boxes can't match dark mode, name the object or
  // validate input. Use useDialogs() / PromptDialog / ConfirmButton from src/web/components/ui/confirm.tsx.
  {
    files: ["src/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": ["error",
        { name: "confirm", message: "Use useDialogs().confirm or ConfirmButton (src/web/components/ui/confirm.tsx)." },
        { name: "prompt", message: "Use useDialogs().prompt or PromptDialog (src/web/components/ui/confirm.tsx)." },
        { name: "alert", message: "Use a toast or a themed Dialog." },
      ],
      "no-restricted-properties": ["error",
        { object: "window", property: "confirm", message: "Use useDialogs().confirm or ConfirmButton (src/web/components/ui/confirm.tsx)." },
        { object: "window", property: "prompt", message: "Use useDialogs().prompt or PromptDialog (src/web/components/ui/confirm.tsx)." },
        { object: "window", property: "alert", message: "Use a toast or a themed Dialog." },
        { object: "globalThis", property: "confirm", message: "Use useDialogs().confirm." },
        { object: "globalThis", property: "prompt", message: "Use useDialogs().prompt." },
      ],
    },
  },
  // R35 Premium pass 2: one icon component. Every glyph comes through src/web/components/ui/icon.tsx (Phosphor,
  // the same family as the phone app), so web and phone stay one product. Add a semantic name there instead.
  {
    files: ["src/web/**/*.{ts,tsx}"],
    ignores: ["src/web/components/ui/icon.tsx"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "lucide-react", message: "Import the glyph by name (IconInbox, IconTasks, ...) from src/web/components/ui/icon.tsx; add new ones to scripts/r35-icon-map.json." },
          { name: "@phosphor-icons/react", message: "Import the glyph by name (IconInbox, IconTasks, ...) from src/web/components/ui/icon.tsx; add new ones to scripts/r35-icon-map.json." },
        ],
        patterns: [{ group: ["lucide-react/*", "@phosphor-icons/react/*"], message: "Import the glyph by name (IconInbox, IconTasks, ...) from src/web/components/ui/icon.tsx; add new ones to scripts/r35-icon-map.json." }],
      }],
    },
  },
  // k6 scripts run in k6's own runtime, which provides these globals.
  { files: ["load/**/*.js"], languageOptions: { globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly" } } },
);
