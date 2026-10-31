import { useEffect, useRef, useState, useSyncExternalStore, type ComponentRef, type ReactNode, type RefObject } from "react";
import { AccessibilityInfo, Keyboard, LayoutAnimation, Linking, Modal, Platform, Pressable, Text, View, type KeyboardEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Badge, Icon } from "@/components/ui";
import { appName, isRemoved, type SocialPostView, LINKEDIN_DELETE_NOTE, needsDeleteNote, networkName, socialErrorText, SOCIAL_NETWORKS, targetChip, type PostTargetView } from "@/lib/social";
import { clearSocialToast, currentSocialToast, subscribeSocialToast } from "@/lib/social-queries";
import { colors, radius, space, TOUCH } from "@/theme";

/**
 * 1.10.6: the pieces Social's screens share: a network mark, one row per network (compact on the Posts list, full on
 * the post page and after posting), the confirm sheet, the short message at the bottom, and the keyboard lift for the
 * composer's footer. Plain React Native, nothing native.
 */

const MARK: Record<string, { bg: string; text: string }> = {
  facebook: { bg: "#1877F2", text: "f" }, linkedin: { bg: "#0A66C2", text: "in" }, instagram: { bg: "#D62976", text: "IG" },
  pinterest: { bg: "#E60023", text: "P" }, reddit: { bg: "#FF4500", text: "r" }, twitter: { bg: "#000000", text: "X" },
  threads: { bg: "#000000", text: "@" }, tiktok: { bg: "#000000", text: "T" }, youtube: { bg: "#FF0000", text: "YT" },
};

/** A small round mark in the network's colour. Decorative: the row says the network's name in words. */
export function NetworkMark({ app, size = 28, muted }: { app: string; size?: number; muted?: boolean }) {
  const m = MARK[app] ?? { bg: colors.subtle, text: app.charAt(0).toUpperCase() };
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: muted ? colors.elevated : m.bg, alignItems: "center", justifyContent: "center", borderWidth: m.bg === "#000000" ? 1 : 0, borderColor: colors.lineStrong }}>
      <Text style={{ color: muted ? colors.subtle : "#FFFFFF", fontWeight: "800", fontSize: size * (m.text.length > 1 ? 0.38 : 0.5) }}>{m.text}</Text>
    </View>
  );
}

/** "Fintex", the Page or profile name, else the network's own name. */
export const targetTitle = (t: PostTargetView) => t.targetName ?? t.label ?? appName(t.app);
/** "Facebook Page", "LinkedIn profile". */
export function targetKind(t: PostTargetView) {
  const k = SOCIAL_NETWORKS[t.app]?.target?.kind;
  return `${networkName(t.app)} ${k === "page" ? "Page" : k === "board" ? "board" : k === "subreddit" ? "community" : "profile"}`;
}

export function LinkText({ label, onPress, testID, color = colors.brand, a11y }: { label: string; onPress: () => void; testID?: string; color?: string; a11y?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y ?? label} hitSlop={8} testID={testID}
      style={({ pressed }) => ({ minHeight: TOUCH, justifyContent: "center", paddingHorizontal: 2, opacity: pressed ? 0.6 : 1 })}>
      <Text style={{ color, fontSize: 15, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export const openPost = (url: string) => { void Linking.openURL(url).catch(() => {}); };

/**
 * One network's row. "compact" (Posts list): mark, name, chip and one action. "full" (post page, after posting):
 * also the kind, the time, the network's own reason, the actions and the quiet LinkedIn note.
 */
export function TargetRow({ t, variant, canManage, onReconnect, onRetry, reconnecting, retrying, textOnly, time, last }: {
  t: PostTargetView; variant: "compact" | "full"; canManage: boolean; onReconnect?: () => void; onRetry?: () => void;
  reconnecting?: boolean; retrying?: boolean; textOnly?: boolean; time?: string | null; last?: boolean;
}) {
  const removed = isRemoved(t);
  const chip = targetChip(t);
  const err = t.status === "failed" ? socialErrorText(t.error) : null;
  const name = targetTitle(t);
  const open = t.url && t.status === "sent" && !removed ? t.url : null;
  const sep = last ? null : { borderBottomWidth: 1, borderBottomColor: colors.line };
  if (variant === "compact") {
    const action = open ? <LinkText label="Open" a11y={`Open post on ${networkName(t.app)}`} onPress={() => openPost(open)} testID={`open-${t.app}`} />
      : err?.reconnect && canManage && onReconnect ? <LinkText label="Reconnect" a11y={`Reconnect ${networkName(t.app)}`} onPress={onReconnect} testID={`reconnect-row-${t.app}`} />
      : err && canManage && onRetry ? <LinkText label="Try again" onPress={onRetry} testID={`retry-row-${t.app}`} />
      : null;
    return (
      <View style={[{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TOUCH }, sep]} testID={`post-target-${t.app}`}>
        <NetworkMark app={t.app} size={22} muted={removed} />
        <Text style={{ flex: 1, color: removed ? colors.subtle : colors.fg, fontSize: 14 }} numberOfLines={1}>{name}</Text>
        <Badge label={chip.label} tone={chip.tone} />
        {action ? <View style={{ minWidth: 44, alignItems: "flex-end" }}>{action}</View> : null}
      </View>
    );
  }
  return (
    <View style={[{ paddingVertical: space.md, gap: 6 }, sep]} testID={`target-${t.app}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <NetworkMark app={t.app} size={32} muted={removed} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ color: removed ? colors.subtle : colors.fg, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>{name}</Text>
          <Text style={{ color: colors.subtle, fontSize: 13 }} numberOfLines={1}>{[targetKind(t), time].filter(Boolean).join(". ")}</Text>
        </View>
        <Badge label={chip.label} tone={chip.tone} icon={t.status === "sent" && !removed ? "check" : undefined} />
      </View>
      <View style={{ paddingLeft: 44, gap: 2 }}>
        {removed ? <Text style={{ color: colors.subtle, fontSize: 14, lineHeight: 19 }} testID="removed-note">This post was deleted on {networkName(t.app)}. There is nothing left to open.</Text> : null}
        {err ? <Text style={{ color: colors.bad, fontSize: 14, lineHeight: 19 }} testID="post-error">{err.text}</Text> : null}
        {textOnly && t.status === "sent" ? <Text style={{ color: colors.subtle, fontSize: 13 }}>Text only. The image was left off here.</Text> : null}
        {needsDeleteNote(t) ? <Text style={{ color: colors.subtle, fontSize: 13, lineHeight: 18 }} testID="linkedin-note">{LINKEDIN_DELETE_NOTE}</Text> : null}
        {open || (err && canManage) ? (
          <View style={{ flexDirection: "row", gap: space.lg, flexWrap: "wrap" }}>
            {open ? <LinkText label="Open post" a11y={`Open post on ${networkName(t.app)}`} onPress={() => openPost(open)} testID={`open-post-${t.app}`} /> : null}
            {err?.reconnect && canManage && onReconnect ? <LinkText label={reconnecting ? "Reconnecting" : `Reconnect ${networkName(t.app)}`} onPress={onReconnect} testID="post-reconnect" /> : null}
            {err && canManage && onRetry ? <LinkText label={retrying ? "Trying again" : "Try again"} onPress={onRetry} testID={`retry-${t.app}`} /> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** A confirm that comes up from the bottom: title, what will happen, a red button and Keep post. */
/** A solid red that keeps white text readable (4.5:1 or better) in light and dark. */
const DANGER_SOLID = "#D32F2F";

export function ConfirmSheet({ visible, title, body, confirmLabel, cancelLabel = "Keep post", onConfirm, onClose, busy, testID }: {
  visible: boolean; title: string; body: string; confirmLabel: string; cancelLabel?: string; onConfirm: () => void; onClose: () => void; busy?: boolean; testID?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)" }} onPress={busy ? undefined : onClose} accessibilityLabel="Close" accessibilityRole="button" />
      <View testID={testID} accessibilityViewIsModal
        style={{ backgroundColor: colors.surface, borderTopLeftRadius: radius.lg + 4, borderTopRightRadius: radius.lg + 4, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: insets.bottom + space.lg, gap: space.md }}>
        <View style={{ alignItems: "center" }}><View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: colors.line }} /></View>
        <View style={{ alignItems: "center", gap: space.sm, paddingTop: space.sm }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.badSoft, alignItems: "center", justifyContent: "center" }}><Icon name="trash-2" size={22} color={colors.bad} /></View>
          <Text style={{ color: colors.fg, fontSize: 20, fontWeight: "700", textAlign: "center" }} accessibilityRole="header">{title}</Text>
          <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 21, textAlign: "center" }} testID={testID ? `${testID}-body` : undefined}>{body}</Text>
        </View>
        <Pressable onPress={onConfirm} disabled={busy} accessibilityRole="button" accessibilityLabel={confirmLabel} accessibilityState={{ disabled: !!busy, busy: !!busy }} testID={testID ? `${testID}-confirm` : undefined}
          style={({ pressed }) => ({ minHeight: 50, borderRadius: radius.md, backgroundColor: DANGER_SOLID, alignItems: "center", justifyContent: "center", paddingHorizontal: space.md, opacity: pressed || busy ? 0.75 : 1 })}>
          <Text style={{ color: "#FFFFFF", fontSize: 16, fontWeight: "700", textAlign: "center" }}>{busy ? "Deleting" : confirmLabel}</Text>
        </Pressable>
        <Pressable onPress={onClose} disabled={busy} accessibilityRole="button" accessibilityLabel={cancelLabel} testID={testID ? `${testID}-cancel` : undefined}
          style={({ pressed }) => ({ minHeight: 50, borderRadius: radius.md, backgroundColor: pressed ? colors.hover : colors.elevated, alignItems: "center", justifyContent: "center" })}>
          <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "600" }}>{cancelLabel}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/** The short message at the bottom of a Social screen. It goes by itself after 4 seconds. */
export function SocialToastHost({ bottom = 0 }: { bottom?: number }) {
  const t = useSyncExternalStore(subscribeSocialToast, currentSocialToast, currentSocialToast);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!t) return;
    AccessibilityInfo.announceForAccessibility?.(t.text);
    const h = setTimeout(() => clearSocialToast(t.id), 4000);
    return () => clearTimeout(h);
  }, [t]);
  if (!t) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: space.lg, right: space.lg, bottom: bottom + insets.bottom + space.lg }}>
      <View accessibilityLiveRegion="polite" testID="social-toast"
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: colors.fg, borderRadius: radius.lg, paddingHorizontal: space.lg, minHeight: 48, paddingVertical: space.sm,
          shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>
        <Icon name={t.tone === "ok" ? "check-circle" : "alert-circle"} size={18} color={colors.bg} />
        <Text style={{ color: colors.bg, fontSize: 15, flex: 1 }}>{t.text}</Text>
      </View>
    </View>
  );
}

/** How far the keyboard covers a box: its bottom edge in the window minus the keyboard's top. Never below zero. */
export function keyboardOverlap(boxBottom: number, keyboardTop: number): number {
  return Math.max(0, Math.round(boxBottom - keyboardTop));
}

/**
 * The space to leave at the bottom of the composer so its footer (with Post) sits right on top of the keyboard, or on
 * top of the home indicator when the keyboard is down. It measures the composer in the window each time the keyboard
 * moves, so it is right wherever the composer sits (under the header and the pinned bar) and on Android whether or not
 * the window was resized for the keyboard.
 */
export function useKeyboardLift(): { ref: RefObject<ComponentRef<typeof View> | null>; lift: number; keyboardUp: boolean } {
  const ref = useRef<ComponentRef<typeof View> | null>(null);
  const [lift, setLift] = useState(0);
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const measure = (e: KeyboardEvent) => {
      const top = e.endCoordinates.screenY;
      ref.current?.measureInWindow((_x: number, y: number, _w: number, h: number) => {
        const next = keyboardOverlap(y + h, top);
        if (Platform.OS === "ios" && e.duration) LayoutAnimation.configureNext({ duration: e.duration, update: { type: LayoutAnimation.Types.keyboard } });
        setLift(next);
      });
    };
    const show = (e: KeyboardEvent) => { setUp(true); measure(e); timers.push(setTimeout(() => measure(e), 250)); };
    const hide = (e: KeyboardEvent) => {
      setUp(false);
      if (Platform.OS === "ios" && e?.duration) LayoutAnimation.configureNext({ duration: e.duration, update: { type: LayoutAnimation.Types.keyboard } });
      setLift(0);
    };
    const subs = Platform.OS === "ios"
      ? [Keyboard.addListener("keyboardWillShow", show), Keyboard.addListener("keyboardWillChangeFrame", (e) => { if (e.endCoordinates.screenY < 10000) measure(e); }), Keyboard.addListener("keyboardWillHide", hide)]
      : [Keyboard.addListener("keyboardDidShow", show), Keyboard.addListener("keyboardDidHide", hide)];
    return () => { subs.forEach((s) => s.remove()); timers.forEach(clearTimeout); };
  }, []);
  return { ref, lift, keyboardUp: up };
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ flex: 1, color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 }} accessibilityRole="header">{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
/** "Sat 31 Oct, 8:26 pm", or "Goes out Mon 2 Nov, 9:00 am" for a scheduled post. */
export const postTime = (p: SocialPostView) => (p.status === "scheduled" ? `Goes out ${when(p.runAt)}` : when(p.targets.find((t) => t.sentAt)?.sentAt ?? p.runAt));

/** Plain words for a failed read. Never a raw code. */
export function plainError(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (!m || /^[a-z_]+$/.test(m) || /fetch|network request/i.test(m)) return "Multies didn't answer. Check your connection and try again.";
  return m;
}
