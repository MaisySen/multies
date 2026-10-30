import Svg, { Circle, G, Polyline, Rect } from "react-native-svg";

const SPARK = "#FF6A1A";

/**
 * The Multies mark: a chunky rounded M with an orange spark. Same geometry as brand/logo-mark.svg.
 * With `tile` (the default) it is drawn white on the near black app tile; without it the M takes `color`.
 * The orange is only ever used for the spark.
 */
export function Logo({ size = 40, tile = true, color = "#1D1D1F" }: { size?: number; tile?: boolean; color?: string }) {
  const stroke = tile ? "#FFFFFF" : color;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityRole="image" accessibilityLabel="Multies" color={stroke}>
      {tile ? <Rect width={100} height={100} rx={22.5} fill="#1D1D1F" /> : null}
      <G transform={tile ? "translate(19 19) scale(0.62)" : undefined}>
        <G transform="translate(0 0.75)">
        <Polyline
          points="20,79 20,39 50,67 80,39 80,79"
          fill="none"
          stroke="currentColor"
          strokeWidth={21}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Circle cx={50} cy={20} r={11} fill={SPARK} />
        </G>
      </G>
    </Svg>
  );
}
