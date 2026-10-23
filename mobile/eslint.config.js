// Expo's recommended rules: https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  { ignores: ["dist/*", "dist-web/*", "android/*", "ios/*", "ios-native/*", "store/*", "node_modules/*", "src/api/v1.d.ts"] },
  {
    rules: {
      // TypeScript already checks every import; this rule misreads enums re-exported by Expo modules.
      "import/namespace": "off",
      // React Compiler advice. Kept visible as warnings: the session keeps its cookie jar in a ref on
      // purpose, and a few forms copy loaded data into editable state once.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // Tests load screens after their mocks are set up, which needs require().
    files: ["__tests__/**", "jest.setup.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);
