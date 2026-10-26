import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Text, View, type AccessibilityActionEvent } from "react-native";
import { armedSide, clampTravel, releaseSide, shouldCaptureSwipe, type SwipeSide } from "@/lib/swipe";
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
export function SwipeRow({ right, left, children, testID }: { right?: SwipeAction; left?: SwipeAction; children: ReactNode; testID?: string }) {
  const [x] = useState(() => new Animated.Value(0));
  const width = useRef(360);
  const armed = useRef<SwipeSide | null>(null);
  const [showing, setShowing] = useState<SwipeSide | null>(null);
  const reduce = useReduceMotion();
  const enabled = useMemo(() => ({ right: !!right, left: !!left }), [right, left]);
  const latest = useRef({ right, left, enabled, reduce });
  useEffect(() => { latest.current = { right, left, enabled, reduce }; });

  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => shouldCaptureSwipe(g.dx, g.dy),
    onMoveShouldSetPanResponderCapture: (_e, g) => shouldCaptureSwipe(g.dx, g.dy),
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_e, g) => {
      const { enabled: en } = latest.current;
      const dx = clampTravel(g.dx, en);
      x.setValue(dx);
      setShowing(dx > 0 ? "right" : dx < 0 ? "left" : null);
      const now = armedSide(dx, width.current, en);
      if (now !== armed.current) { armed.current = now; if (now) tick(); }
    },
    onPanResponderRelease: (_e, g) => {
      const { enabled: en, reduce: r } = latest.current;
      const side = releaseSide(clampTravel(g.dx, en), g.vx, width.current, en);
      armed.current = null;
      if (!side) {
        Animated.spring(x, { toValue: 0, useNativeDriver: true, ...motion.spring }).start(() => setShowing(null));
        return;
      }
      const action = side === "right" ? latest.current.right : latest.current.left;
      success();
      Animated.timing(x, { toValue: (side === "right" ? 1 : -1) * width.current, duration: r ? 0 : motion.base, useNativeDriver: true }).start(() => {
        action?.onAction();
        x.setValue(0);
        setShowing(null);
      });
    },
    onPanResponderTerminate: () => {
      armed.current = null;
      Animated.spring(x, { toValue: 0, useNativeDriver: true, ...motion.spring }).start(() => setShowing(null));
    },
  }), [x]);

  const actions = [right ? { name: "swipe-right", label: right.label } : null, left ? { name: "swipe-left", label: left.label } : null].filter((a): a is { name: string; label: string } => !!a);
  const onA11y = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "swipe-right") right?.onAction();
    if (e.nativeEvent.actionName === "swipe-left") left?.onAction();
  };
  const under = showing === "right" ? right : showing === "left" ? left : undefined;

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
