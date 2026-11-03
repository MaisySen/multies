import { StyleSheet, Text } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { Hero, HeroAction } from "@/components/m4-ui";
import { shouldRetry } from "@/lib/retry";

jest.mock("react-native-svg", () => {
  const { View } = require("react-native");
  const React = require("react");
  const C = (props: Record<string, unknown>) => React.createElement(View, props, props.children);
  return { __esModule: true, default: C, Svg: C, Defs: C, LinearGradient: C, Stop: C, Rect: C, Path: C, Circle: C, G: C };
});

/**
 * M5: the Today hero on a phone. 1.10.12 drew the gradient at "100%" inside an absolute fill, which iOS sized before the
 * card's content laid out, so the colour stopped short and the buttons hung below it. The card is now sized only by its
 * own padding and content; the gradient is drawn at the card's measured size and the card carries a solid fill.
 */
describe("M5 hero layout", () => {
  const tree = async () => { await render(
    <Hero testID="today-hero" title="Good morning, Bidurkumar" subtitle="142 tasks need you today. Next: Kiosk fit out walkthrough Wed 10:00 am.">
      <HeroAction icon="compose" label="Write" onPress={() => {}} testID="a1" />
      <HeroAction icon="tasks" label="My tasks" onPress={() => {}} testID="a2" />
      <HeroAction icon="search" label="Search" onPress={() => {}} testID="a3" />
    </Hero>,
  ); return screen; };

  it("is sized by its own content, with a solid fill under the gradient", async () => {
    const s = StyleSheet.flatten((await tree()).getByTestId("today-hero").props.style);
    expect(s.alignSelf).toBe("stretch");
    expect(s.width).toBeUndefined();
    expect(s.height).toBeUndefined();
    expect(typeof s.backgroundColor).toBe("string");
    expect(s.overflow).toBe("hidden");
    expect(s.padding).toBeGreaterThan(0);
  });

  it("draws the gradient at exactly the measured card size, and only once measured", async () => {
    const r = await tree();
    expect(r.queryByTestId("today-hero-fill")).toBeNull();
    await act(async () => { r.getByTestId("today-hero").props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 343, height: 214 } } }); });
    const fill = r.getByTestId("today-hero-fill");
    expect(StyleSheet.flatten(fill.props.style)).toMatchObject({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 });
    expect(fill.props.pointerEvents).toBe("none");
    const svg = fill.children[0] as unknown as { props: { width: number; height: number } };
    expect(svg.props.width).toBe(343);
    expect(svg.props.height).toBe(214);
    // Taller card (a long name wraps, or larger text): the gradient follows.
    await act(async () => { r.getByTestId("today-hero").props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 343, height: 262 } } }); });
    expect((r.getByTestId("today-hero-fill").children[0] as unknown as { props: { height: number } }).props.height).toBe(262);
  });

  it("keeps the actions in normal flow: one row, equal shares, no absolute position or negative margins", async () => {
    const r = await tree();
    const ids = ["a1", "a2", "a3"];
    for (const id of ids) {
      const btn = r.getByTestId(id);
      const style = typeof btn.props.style === "function" ? btn.props.style({ pressed: false }) : btn.props.style;
      const s = StyleSheet.flatten(style);
      expect(s.flex).toBe(1);
      expect(s.position).toBeUndefined();
      for (const k of ["margin", "marginTop", "marginBottom", "marginLeft", "marginRight"] as const) expect((s[k] as number | undefined) ?? 0).toBeGreaterThanOrEqual(0);
    }
    const row = StyleSheet.flatten(r.getByTestId("a1").parent?.parent?.props.style ?? r.getByTestId("a1").parent?.props.style);
    expect(row?.flexWrap).not.toBe("wrap");
    expect(r.getAllByText(/Write|My tasks|Search/).length).toBe(3);
    expect(Text).toBeDefined();
  });
});

describe("M5 retry", () => {
  it("does not retry answers the server gave on purpose", () => {
    expect(shouldRetry(0, { status: 404 })).toBe(false);
    expect(shouldRetry(0, { status: 401 })).toBe(false);
    expect(shouldRetry(0, { status: 403 })).toBe(false);
    expect(shouldRetry(0, { status: 429 })).toBe(true);
    expect(shouldRetry(0, { status: 503 })).toBe(true);
    expect(shouldRetry(0, { status: 0 })).toBe(true);
    expect(shouldRetry(0, new Error("offline"))).toBe(true);
    expect(shouldRetry(2, { status: 503 })).toBe(false);
  });
});
