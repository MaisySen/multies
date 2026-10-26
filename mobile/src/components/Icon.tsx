import { Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import { ICON_PATHS } from "./icon-paths";
import { sfSymbolFor } from "./sf-symbols";
import { nativeSymbols } from "@/lib/native-modules";

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
 * The one icon component. R37: on iOS builds from 1.10.0 it draws the matching SF Symbol natively
 * (src/components/sf-symbols.ts) with the SVG below as the fallback.
 * iOS and web draw Phosphor (regular weight, fill when `filled`), the
 * closest open set to SF Symbols; Android draws Material Symbols Rounded (outline, fill when
 * `filled`). Both are plain SVG paths on react-native-svg, so no native module or font is needed.
 * Hidden from screen readers: the control carries the label.
 */
export function Icon({ name, size = 20, color = "#5F5F64", filled = false }: { name: IconName; size?: number; color?: string; filled?: boolean }) {
  const g = iconGlyph(name, filled);
  const svg = (
    <Svg width={size} height={size} viewBox={g.viewBox} fill={color} accessibilityElementsHidden importantForAccessibility="no" testID={`icon-${name}`}>
      <Path d={g.d} fill={color} />
    </Svg>
  );
  // R37: real SF Symbols on iOS when the binary has expo-symbols and the name has a mapping.
  const symbol = Platform.OS === "ios" ? sfSymbolFor(name, filled) : null;
  const S = symbol ? nativeSymbols() : null;
  if (S && symbol) {
    return (
      <S.SymbolView name={symbol as never} size={size} tintColor={color} type="monochrome" weight="regular" resizeMode="scaleAspectFit"
        fallback={svg} style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no" testID={`icon-${name}`} />
    );
  }
  return svg;
}
