import { Linking } from "react-native";
import type { ReactElement } from "react";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CriticalUpdateNotice, StoreUpdateScreen, WhatsNewSheet } from "@/components/ota";
import { updateStatusLabel } from "@/components/update-rows";
import { WHATS_NEW } from "@/lib/ota/whats-new.generated";
import { JS_VERSION } from "@/lib/app-version";
const { parseChangelog, upToDate } = require("../scripts/whats-new");
const { readFileSync } = require("fs");
const { join } = require("path");

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
async function render(ui: ReactElement) {
  await rtlRender(<SafeAreaProvider initialMetrics={metrics}>{ui}</SafeAreaProvider>);
  return screen;
}

describe("update screens", () => {
  it("blocks with a store button that opens the store page", async () => {
    const open = jest.spyOn(Linking, "openURL").mockImplementation(async () => {});
    const s = await render(<StoreUpdateScreen os="ios" storeUrl="https://apps.apple.com/app/id6826562106" />);
    expect(s.getByText("Update Multies to continue")).toBeTruthy();
    fireEvent.press(s.getByText("Open the App Store"));
    expect(open).toHaveBeenCalledWith("https://apps.apple.com/app/id6826562106");
  });

  it("shows the server's message and no button without a store link", async () => {
    const a = await render(<StoreUpdateScreen os="android" storeUrl={null} message="Version 2 is required." />);
    expect(a.getByText("Version 2 is required.")).toBeTruthy();
    expect(a.queryByText("Open Google Play")).toBeNull();
  });

  it("shows the critical notice", async () => {
    expect((await render(<CriticalUpdateNotice text="Installing an important update." />)).getByText("Installing an important update.")).toBeTruthy();
  });

  it("lists What's new and closes", async () => {
    const onClose = jest.fn();
    const s = await render(<WhatsNewSheet version="1.9.6" items={[{ title: "Check for updates", body: "In Settings." }]} onClose={onClose} />);
    expect(s.getByText("What's new")).toBeTruthy();
    expect(s.getByText("Check for updates")).toBeTruthy();
    fireEvent.press(s.getByText("Continue"));
    expect(onClose).toHaveBeenCalled();
  });

  it("labels each update state", () => {
    expect(updateStatusLabel("up_to_date")).toBe("Up to date");
    expect(updateStatusLabel("ready")).toBe("Ready");
    expect(updateStatusLabel("idle")).toBe("");
  });
});

describe("What's new notes", () => {
  it("are generated from CHANGELOG.md and up to date", () => {
    expect(upToDate()).toBe(true);
  });
  it("have notes for the running JS version, without the internal OTA line", () => {
    expect(WHATS_NEW[JS_VERSION]?.length).toBeGreaterThan(0);
    expect(JSON.stringify(WHATS_NEW)).not.toMatch(/Shipped over the air/);
  });
  it("parse bullets, wrapped lines and the What to test paragraph", () => {
    const md = "# Changelog\n\n## 2.0.0 (OTA), 1 Jan\n\n- Inbox: faster\n  scrolling.\n- Plain line\n- Shipped over the air (no store build).\n\nWhat to test: x\n- not a note\n\n## 1.0.0, 1 Jan\n\n- First\n";
    expect(parseChangelog(md)).toEqual([
      { version: "2.0.0", items: [{ title: "Inbox", body: "Faster scrolling." }, { title: "", body: "Plain line" }] },
      { version: "1.0.0", items: [{ title: "", body: "First" }] },
    ]);
  });
  it("keep the What to test text out of the sheet", () => {
    const md = readFileSync(join(__dirname, "..", "CHANGELOG.md"), "utf8");
    expect(md).toContain("What to test");
    expect(JSON.stringify(WHATS_NEW)).not.toContain("What to test");
  });
});
