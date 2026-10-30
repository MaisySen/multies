import { Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import { ICON_PATHS } from "./icon-paths";

export type IconName = keyof typeof ICON_PATHS;
export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

/** Which icon family the platform draws: Phosphor on iOS and web, Material Symbols Rounded on Android. */
export function iconFamily(os: string = Platform.OS): "phosphor" | "material" {
  return os === "android" ? "material" : "phosphor";
}

/** The SVG path and viewBox for one icon on one platform. `filled` is the selected or active state. */
export function iconGlyph(name: IconName, filled = false, os: string = Platform.OS): { d: string; viewBox: string } {
  const [ios, iosFill, android, androidFill] = ICON_PATHS[name] ?? ICON_PATHS["circle"];
  return iconFamily(os) === "material"
    ? { d: filled ? androidFill : android, viewBox: "0 -960 960 960" }
    : { d: filled ? iosFill : ios, viewBox: "0 0 256 256" };
}

/**
 * The one icon component. iOS and web draw Phosphor (regular weight, fill when `filled`), the
 * closest open set to SF Symbols; Android draws Material Symbols Rounded (outline, fill when
 * `filled`). Both are plain SVG paths on react-native-svg, so no native module or font is needed.
 * Hidden from screen readers: the control carries the label.
 */
export function Icon({ name, size = 20, color = "#5F5F64", filled = false }: { name: IconName; size?: number; color?: string; filled?: boolean }) {
  const g = iconGlyph(name, filled);
  return (
    <Svg width={size} height={size} viewBox={g.viewBox} fill={color} accessibilityElementsHidden importantForAccessibility="no" testID={`icon-${name}`}>
      <Path d={g.d} fill={color} />
    </Svg>
  );
}
