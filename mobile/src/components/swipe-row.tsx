import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { tr } from "@/i18n";
import { Animated, PanResponder, Pressable, Text, View, type AccessibilityActionEvent } from "react-native";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { clampTravel, releaseSide, shouldCaptureSwipe, stageKey, swipeStage, type SwipeStage } from "@/lib/swipe";
import { useReduceMotion } from "@/lib/motion";
import { tick, success } from "@/lib/haptics";
import { Icon, type IconName } from "./ui";
import { colors, motion, space } from "@/theme";

export interface SwipeAction { label: string; icon: IconName; color: string; onAction: () => void }

/**
 * R31: swipe a row right or left for its two quick actions (built on PanResponder and Animated,
 * no native module). The colour and icon show under the row; a light tick marks the commit line.
 * Screen reader users get the same two actions as accessibility actions on the row.
 */
export function SwipeRow({ right, left, rightLong, leftLong, children, testID }: { right?: SwipeAction; left?: SwipeAction; rightLong?: SwipeAction; leftLong?: SwipeAction; children: ReactNode; testID?: string }) {
  const [x] = useState(() => new Animated.Value(0));
  const width = useRef(360);
  const armed = useRef<SwipeStage>(null);
  const [showing, setShowing] = useState<"right" | "left" | null>(null);
  const [long, setLong] = useState(false);
  const reduce = useReduceMotion();
  const enabled = useMemo(() => ({ right: !!right, left: !!left }), [right, left]);
  const hasLong = useMemo(() => ({ right: !!rightLong, left: !!leftLong }), [rightLong, leftLong]);
  const latest = useRef({ right, left, rightLong, leftLong, enabled, hasLong, reduce });
  useEffect(() => { latest.current = { right, left, rightLong, leftLong, enabled, hasLong, reduce }; });

  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => shouldCaptureSwipe(g.dx, g.dy),
    onMoveShouldSetPanResponderCapture: (_e, g) => shouldCaptureSwipe(g.dx, g.dy),
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_e, g) => {
      const { enabled: en, hasLong: hl } = latest.current;
      const dx = clampTravel(g.dx, en);
      x.setValue(dx);
      setShowing(dx > 0 ? "right" : dx < 0 ? "left" : null);
      const now = swipeStage(dx, width.current, en, hl);
      if (stageKey(now) !== stageKey(armed.current)) { armed.current = now; setLong(!!now?.long); if (now) tick(); }
    },
    onPanResponderRelease: (_e, g) => {
      const { enabled: en, reduce: r } = latest.current;
      const side = releaseSide(clampTravel(g.dx, en), g.vx, width.current, en);
      const wasLong = !!armed.current?.long && armed.current.side === side;
      armed.current = null;
      setLong(false);
      if (!side) {
        Animated.spring(x, { toValue: 0, useNativeDriver: true, ...motion.spring }).start(() => setShowing(null));
        return;
      }
      const l = latest.current;
      const action = side === "right" ? (wasLong ? l.rightLong : l.right) : (wasLong ? l.leftLong : l.left);
      success();
      Animated.timing(x, { toValue: (side === "right" ? 1 : -1) * width.current, duration: r ? 0 : motion.base, useNativeDriver: true }).start(() => {
        action?.onAction();
        x.setValue(0);
        setShowing(null);
      });
    },
    onPanResponderTerminate: () => {
      armed.current = null;
      setLong(false);
      Animated.spring(x, { toValue: 0, useNativeDriver: true, ...motion.spring }).start(() => setShowing(null));
    },
  }), [x]);

  const named: [string, SwipeAction | undefined][] = [["swipe-right", right], ["swipe-right-long", rightLong], ["swipe-left", left], ["swipe-left-long", leftLong]];
  const actions = named.filter(([, a]) => !!a).map(([name, a]) => ({ name, label: a!.label }));
  const onA11y = (e: AccessibilityActionEvent) => { named.find(([n]) => n === e.nativeEvent.actionName)?.[1]?.onAction(); };
  const under = showing === "right" ? (long && rightLong ? rightLong : right) : showing === "left" ? (long && leftLong ? leftLong : left) : undefined;

  return (
    <View onLayout={(e) => { width.current = e.nativeEvent.layout.width || width.current; }} style={{ overflow: "hidden" }} testID={testID}>
      {under ? (
        <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: under.color, flexDirection: "row", alignItems: "center",
          justifyContent: showing === "right" ? "flex-start" : "flex-end", paddingHorizontal: space.xl, gap: space.sm }} importantForAccessibility="no-hide-descendants">
          {showing === "right" ? <Icon name={under.icon} size={22} color="#FFFFFF" /> : null}
          <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "700" }}>{under.label}</Text>
          {showing === "left" ? <Icon name={under.icon} size={22} color="#FFFFFF" /> : null}
        </View>
      ) : null}
      <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX: x }], backgroundColor: colors.bg }}
        accessibilityActions={actions} onAccessibilityAction={onA11y}>
        {children}
      </Animated.View>
    </View>
  );
}

/** R33: a one-time hint above a swipeable list. It goes once tapped and does not come back. */
export function SwipeHint({ testID = "swipe-hint" }: { testID?: string }) {
  const prefs = usePrefs();
  if (prefs.swipeHintSeen) return null;
  return (
    <Pressable onPress={() => setPrefs({ swipeHintSeen: true })} accessibilityRole="button" accessibilityLabel={`${tr("m.swipe.hint")} ${tr("m.swipe.tap_to_hide")}`} testID={testID}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, marginBottom: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: 12, backgroundColor: colors.brandSoft }}>
      <Icon name="arrow-right" size={16} color={colors.brand} />
      <Text style={{ flex: 1, color: colors.fg, fontSize: 14 }}>{tr("m.swipe.hint")}</Text>
      <Icon name="x" size={16} color={colors.muted} />
    </Pressable>
  );
}
