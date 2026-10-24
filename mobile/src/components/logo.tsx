import Svg, { Path, Rect } from "react-native-svg";

/** The Multies mark: an M whose middle stroke is an envelope flap, white on the blue tile. Same geometry as brand/logo-mark.svg. */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityRole="image" accessibilityLabel="Multies">
      <Rect width={64} height={64} rx={14.4} fill="#0071E3" />
      <Path d="M18 44V21l14 12 14-12v23" fill="none" stroke="#FFFFFF" strokeWidth={5.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
