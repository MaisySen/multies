import Svg, { Circle, G, Path, Rect } from "react-native-svg";
import { colors } from "@/theme";
import type { IconName } from "./icons";

/** R34: one small illustration per main list, drawn in the brand blue. */
export type EmptyArt = "inbox" | "tasks" | "chat" | "approvals" | "activity" | "search" | "calendar";

/** The illustration an EmptyState shows for its icon, when there is one. */
export function artFor(icon: IconName): EmptyArt | null {
  switch (icon) {
    case "inbox": case "mail": return "inbox";
    case "check-square": case "tasks": return "tasks";
    case "message-circle": case "message-square": case "chat": return "chat";
    case "check-circle": case "approvals": return "approvals";
    case "bell": case "activity-bell": return "activity";
    case "search": return "search";
    case "calendar": case "video": case "meeting": return "calendar";
    default: return null;
  }
}

/** A 160 by 120 drawing: a soft halo, a card, and the list's own motif. Hidden from screen readers. */
export function EmptyIllustration({ art, size = 160 }: { art: EmptyArt; size?: number }) {
  const b = colors.brand, soft = colors.brandSoft, card = colors.surface, line = colors.lineStrong;
  return (
    <Svg width={size} height={size * 0.75} viewBox="0 0 160 120" accessibilityElementsHidden importantForAccessibility="no" testID={`empty-art-${art}`}>
      <Circle cx="80" cy="62" r="54" fill={soft} />
      <Circle cx="132" cy="22" r="5" fill={b} opacity={0.35} />
      <Circle cx="24" cy="34" r="3.5" fill={b} opacity={0.5} />
      <Circle cx="140" cy="92" r="3" fill={b} opacity={0.4} />
      {art === "inbox" ? (
        <G>
          <Rect x="38" y="34" width="84" height="58" rx="10" fill={card} stroke={line} strokeWidth="1.5" />
          <Path d="M38 66h22l6 10h28l6-10h22" fill="none" stroke={b} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
          <Path d="M66 50l10 9 18-18" fill="none" stroke={b} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </G>
      ) : art === "tasks" ? (
        <G>
          <Rect x="40" y="26" width="80" height="72" rx="10" fill={card} stroke={line} strokeWidth="1.5" />
          {[42, 60, 78].map((y, i) => (
            <G key={y}>
              <Rect x="50" y={y} width="12" height="12" rx="3.5" fill={i === 0 ? b : "none"} stroke={b} strokeWidth="2" />
              {i === 0 ? <Path d={`M53 ${y + 6}l2.5 2.5 4.5-5`} fill="none" stroke={card} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /> : null}
              <Rect x="70" y={y + 3} width={i === 0 ? 30 : 40} height="6" rx="3" fill={line} />
            </G>
          ))}
        </G>
      ) : art === "chat" ? (
        <G>
          <Path d="M34 38a10 10 0 0 1 10-10h50a10 10 0 0 1 10 10v26a10 10 0 0 1-10 10H58l-14 12V74a10 10 0 0 1-10-10z" fill={card} stroke={line} strokeWidth="1.5" />
          <Path d="M66 56a10 10 0 0 1 10-10h40a10 10 0 0 1 10 10v20a10 10 0 0 1-10 10v10l-12-10H76a10 10 0 0 1-10-10z" fill={b} />
          <Circle cx="84" cy="66" r="3" fill={card} /><Circle cx="96" cy="66" r="3" fill={card} /><Circle cx="108" cy="66" r="3" fill={card} />
        </G>
      ) : art === "approvals" ? (
        <G>
          <Rect x="44" y="28" width="72" height="68" rx="10" fill={card} stroke={line} strokeWidth="1.5" />
          <Rect x="56" y="42" width="48" height="6" rx="3" fill={line} /><Rect x="56" y="54" width="34" height="6" rx="3" fill={line} />
          <Circle cx="104" cy="84" r="16" fill={b} />
          <Path d="M96 84l6 6 10-11" fill="none" stroke={card} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        </G>
      ) : art === "calendar" ? (
        <G>
          {/* R36: a calendar page with today ringed, for meetings. */}
          <Rect x="40" y="28" width="80" height="70" rx="10" fill={card} stroke={line} strokeWidth="1.5" />
          <Path d="M40 38a10 10 0 0 1 10-10h60a10 10 0 0 1 10 10v8H40z" fill={b} />
          <Rect x="56" y="22" width="5" height="12" rx="2.5" fill={b} /><Rect x="99" y="22" width="5" height="12" rx="2.5" fill={b} />
          {[0, 1, 2, 3].map((c) => [0, 1, 2].map((r) => (
            <Rect key={`${c}-${r}`} x={52 + c * 16} y={56 + r * 12} width="8" height="6" rx="2" fill={c === 2 && r === 1 ? b : line} />
          )))}
          <Circle cx="88" cy="71" r="9" fill="none" stroke={b} strokeWidth="2" />
        </G>
      ) : art === "activity" ? (
        <G>
          <Path d="M80 30c-14 0-24 10-24 24v14l-8 10h64l-8-10V54c0-14-10-24-24-24z" fill={card} stroke={line} strokeWidth="1.5" />
          <Path d="M72 84a8 8 0 0 0 16 0" fill="none" stroke={b} strokeWidth="3" strokeLinecap="round" />
          <Circle cx="98" cy="36" r="8" fill={b} />
        </G>
      ) : (
        <G>
          <Circle cx="74" cy="56" r="22" fill={card} stroke={b} strokeWidth="4" />
          <Path d="M90 72l18 18" stroke={b} strokeWidth="6" strokeLinecap="round" />
        </G>
      )}
    </Svg>
  );
}
