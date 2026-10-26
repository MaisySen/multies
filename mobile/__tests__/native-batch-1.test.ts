import { QUICK_ACTIONS, quickActionHref, shouldAskForReview, REVIEW_AFTER, biometricAvailable, recordTaskCompleted } from "@/lib/native-features";
import { sfSymbolFor, SF_SYMBOLS } from "@/components/sf-symbols";
import { ICON_NAMES } from "@/components/Icon";
import { nativeSymbols, nativeBlur, nativeContextMenu, nativeLocalAuth, nativeQuickActions, nativeStoreReview } from "@/lib/native-modules";
import { hasNativeMenu } from "@/components/native-menu";
import { hasBarBlur } from "@/components/chrome";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

const app = require("../app.json").expo;
const pkg = require("../package.json");

describe("R37 native batch 1 (store build 1.10.0)", () => {
  it("bumps the version and the Android versionCode", () => {
    expect(app.version).toBe("1.10.0");
    expect(app.android.versionCode).toBe(16);
    expect(app.runtimeVersion).toEqual({ policy: "fingerprint" });
  });

  it("adds the native packages and drops lucide-react-native", () => {
    for (const p of ["expo-blur", "expo-symbols", "zeego", "react-native-ios-context-menu", "react-native-ios-utilities", "@react-native-menu/menu",
      "react-native-gesture-handler", "react-native-reanimated", "react-native-worklets", "expo-local-authentication", "expo-quick-actions", "expo-store-review"]) {
      expect(pkg.dependencies[p]).toBeTruthy();
    }
    expect(pkg.dependencies["lucide-react-native"]).toBeUndefined();
  });

  it("configures Face ID and biometrics permissions", () => {
    const la = app.plugins.find((p: unknown) => Array.isArray(p) && p[0] === "expo-local-authentication");
    expect(la[1].faceIDPermission).toMatch(/Face ID/);
    expect(app.android.permissions).toContain("android.permission.USE_BIOMETRIC");
    expect(app.android.blockedPermissions).not.toContain("android.permission.USE_BIOMETRIC");
    expect(app.android.blockedPermissions).not.toContain("com.sec.android.provider.badge.permission.WRITE");
    expect(app.plugins).toContain("expo-quick-actions");
  });

  it("has four quick actions that open real screens", () => {
    expect(QUICK_ACTIONS.map((a) => a.title)).toEqual(["New task", "Compose", "Search", "Inbox"]);
    expect(quickActionHref({ id: "compose" })).toBe("/compose");
    expect(quickActionHref({ id: "x", params: { href: "/search" } })).toBe("/search");
    expect(quickActionHref({ id: "nope" })).toBeNull();
    expect(quickActionHref(null)).toBeNull();
  });

  it("asks for a review once, after the fifth completed task", () => {
    expect(REVIEW_AFTER).toBe(5);
    expect(shouldAskForReview(4, false)).toBe(false);
    expect(shouldAskForReview(5, false)).toBe(true);
    expect(shouldAskForReview(9, true)).toBe(false);
  });

  it("maps icons to SF Symbols, with fill variants only where they exist", () => {
    expect(sfSymbolFor("inbox")).toBe("tray");
    expect(sfSymbolFor("inbox", true)).toBe("tray.fill");
    expect(sfSymbolFor("search", true)).toBe("magnifyingglass");
    const mapped = ICON_NAMES.filter((n) => SF_SYMBOLS[n]);
    expect(mapped.length).toBe(ICON_NAMES.length);
  });

  it("fails soft when the native modules are missing (tests, web, older binaries)", async () => {
    for (const f of [nativeSymbols, nativeBlur, nativeContextMenu, nativeLocalAuth, nativeQuickActions, nativeStoreReview]) expect(f()).toBeNull();
    expect(hasNativeMenu()).toBe(false);
    expect(hasBarBlur()).toBe(false);
    await expect(biometricAvailable()).resolves.toBe(false);
    await expect(recordTaskCompleted()).resolves.toBeUndefined();
  });
});
