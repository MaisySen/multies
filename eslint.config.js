import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // mobile/ is the Expo app, merged from the mobile branch, with its own lint and tests.
  // deploy/auth0: scripts that run inside the identity provider (its globals, not ours); tests/auth0-legacy-migration.test.ts runs them.
  { ignores: ["dist", ".wrangler", "node_modules", "drizzle", "coverage", "src/server/db/migrations.generated.ts", "mobile", "deploy/auth0"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
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
  // k6 scripts run in k6's own runtime, which provides these globals.
  { files: ["load/**/*.js"], languageOptions: { globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly" } } },
);
