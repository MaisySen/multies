import { useState } from "react";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import { router } from "expo-router";
import { Icon } from "@/components/ui";
import { phoneTarget } from "@/lib/global-search";
import { imageSource, type Block, type Span } from "@/lib/docs";
import { openWebPath } from "@/lib/docs-queries";
import { colors, radius, space } from "@/theme";

const MONO = "Menlo";

/** Follows a link in a doc: the app's own pages open their phone screen when there is one, others the browser. */
export function followLink(href: string) {
  if (href.startsWith("/")) {
    const t = phoneTarget({ type: "docs", id: "", url: href });
    if (t.kind === "screen") router.push({ pathname: t.pathname as never, params: t.params });
    else void openWebPath(t.path);
    return;
  }
  void Linking.openURL(href).catch(() => {});
}

function Spans({ spans, style }: { spans: Span[]; style?: TextStyle }) {
  return (
    <Text style={[st.body, style]} selectable>
      {spans.map((s, i) => {
        const look: { -readonly [K in keyof TextStyle]: TextStyle[K] } = {};
        if (s.bold) look.fontWeight = "700";
        if (s.italic) look.fontStyle = "italic";
        const lines = [s.strike && "line-through", (s.underline || s.href) && "underline"].filter(Boolean).join(" ");
        if (lines) look.textDecorationLine = lines as TextStyle["textDecorationLine"];
        if (s.code) Object.assign(look, { fontFamily: MONO, fontSize: 15, backgroundColor: colors.neutralSoft });
        if (s.href) look.color = colors.brand;
        if (s.mention) look.color = colors.brand;
        return s.href
          ? <Text key={i} style={look} onPress={() => followLink(s.href!)} accessibilityRole="link" accessibilityHint="Opens the link">{s.text}</Text>
          : <Text key={i} style={look}>{s.text}</Text>;
      })}
    </Text>
  );
}

const HEADING: Record<1 | 2 | 3 | 4, TextStyle> = {
  1: { fontSize: 26, fontWeight: "700", lineHeight: 32 },
  2: { fontSize: 22, fontWeight: "700", lineHeight: 28 },
  3: { fontSize: 19, fontWeight: "600", lineHeight: 25 },
  4: { fontSize: 17, fontWeight: "600", lineHeight: 22 },
};

const CALLOUT = {
  info: { bg: colors.brandSoft, fg: colors.brand, icon: "info" as const, label: "Note" },
  success: { bg: colors.okSoft, fg: colors.ok, icon: "check-circle" as const, label: "Tip" },
  warning: { bg: colors.warnSoft, fg: colors.warn, icon: "alert-circle" as const, label: "Warning" },
  danger: { bg: colors.badSoft, fg: colors.bad, icon: "alert-circle" as const, label: "Important" },
};

function DocImage({ b, base, headers }: { b: Extract<Block, { t: "image" }>; base: string; headers: () => Record<string, string> }) {
  const [failed, setFailed] = useState(false);
  const ratio = b.width && b.height ? Math.min(Math.max(b.width / b.height, 0.3), 4) : 16 / 10;
  if (failed) {
    return (
      <View style={st.missing} accessibilityRole="image" accessibilityLabel={b.alt || "Image that could not load"}>
        <Icon name="alert-circle" size={18} color={colors.subtle} />
        <Text style={{ color: colors.subtle, fontSize: 14, flex: 1 }}>{b.alt ? `${b.alt}. ` : ""}This image could not load.</Text>
      </View>
    );
  }
  return (
    <Image source={imageSource(b.src, base, headers)} onError={() => setFailed(true)} resizeMode="contain" accessible accessibilityRole="image"
      accessibilityLabel={b.alt || "Image"} style={{ width: "100%", aspectRatio: ratio, borderRadius: radius.md, backgroundColor: colors.neutralSoft }} />
  );
}

/** Draws a doc's blocks natively, read only. */
export function DocBlocks({ blocks, base, headers, onOpenWeb, nested = false }: { blocks: Block[]; base: string; headers: () => Record<string, string>; onOpenWeb: () => void; nested?: boolean }) {
  return (
    <View style={{ gap: nested ? space.xs : space.md }}>
      {blocks.map((b, i) => <BlockView key={i} b={b} base={base} headers={headers} onOpenWeb={onOpenWeb} />)}
    </View>
  );
}

function BlockView({ b, base, headers, onOpenWeb }: { b: Block; base: string; headers: () => Record<string, string>; onOpenWeb: () => void }) {
  const sub = (blocks: Block[]) => <DocBlocks blocks={blocks} base={base} headers={headers} onOpenWeb={onOpenWeb} nested />;
  switch (b.t) {
    case "heading": return <View accessibilityRole="header"><Spans spans={b.spans} style={HEADING[b.level]} /></View>;
    case "paragraph": return b.spans.length ? <Spans spans={b.spans} /> : <View style={{ height: 6 }} />;
    case "list":
      return (
        <View style={{ gap: space.xs }}>
          {b.items.map((item, i) => (
            <View key={i} style={st.li}>
              <Text style={[st.body, st.marker]} accessibilityElementsHidden importantForAccessibility="no">{b.ordered ? `${b.start + i}.` : "\u2022"}</Text>
              <View style={{ flex: 1 }}>{sub(item)}</View>
            </View>
          ))}
        </View>
      );
    case "tasks":
      return (
        <View style={{ gap: space.xs }}>
          {b.items.map((item, i) => (
            <View key={i} style={st.li} accessible accessibilityRole="checkbox" accessibilityState={{ checked: item.checked, disabled: true }}>
              <View style={[st.marker, { paddingTop: 2 }]}><Icon name={item.checked ? "check-square" : "square"} size={18} color={item.checked ? colors.ok : colors.subtle} filled={item.checked} /></View>
              <View style={{ flex: 1, opacity: item.checked ? 0.7 : 1 }}>{sub(item.blocks)}</View>
            </View>
          ))}
        </View>
      );
    case "quote": return <View style={st.quote}>{sub(b.blocks)}</View>;
    case "code":
      return (
        <ScrollView horizontal style={st.code} contentContainerStyle={{ padding: space.md }} accessibilityLabel={`Code${b.language ? `, ${b.language}` : ""}`}>
          <Text style={{ fontFamily: MONO, fontSize: 14, lineHeight: 20, color: colors.fg }} selectable>{b.text}</Text>
        </ScrollView>
      );
    case "rule": return <View style={st.rule} accessibilityElementsHidden importantForAccessibility="no" />;
    case "image": return <DocImage b={b} base={base} headers={headers} />;
    case "table":
      return (
        <View style={st.table} accessibilityLabel="Table">
          {b.rows.map((r, ri) => (
            <View key={ri} style={[st.tr, ri > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong }, r.header && { backgroundColor: colors.neutralSoft }]}>
              {r.cells.map((c, ci) => (
                <View key={ci} style={[st.td, ci > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.lineStrong }]}>
                  <Spans spans={c} style={{ fontSize: 15, lineHeight: 20, ...(r.header ? { fontWeight: "600" } : {}) }} />
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    case "callout": {
      const c = CALLOUT[b.variant];
      return (
        <View style={[st.callout, { backgroundColor: c.bg }]} accessibilityRole="summary" accessibilityLabel={c.label}>
          <Icon name={c.icon} size={18} color={c.fg} />
          <View style={{ flex: 1 }}>{sub(b.blocks)}</View>
        </View>
      );
    }
    case "web":
      return (
        <View style={st.webCard}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Icon name="globe" size={18} color={colors.subtle} />
            <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "600", flex: 1 }}>{b.what}</Text>
          </View>
          {b.words.length ? <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 20 }} numberOfLines={6}>{b.words.join("\n")}</Text> : null}
          <Text style={{ color: colors.subtle, fontSize: 14 }}>Open on the web to see this.</Text>
          <Pressable onPress={onOpenWeb} accessibilityRole="button" accessibilityLabel={`Open ${b.what.toLowerCase()} on the web`} hitSlop={6} style={st.webBtn}>
            <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>Open on the web</Text>
            <Icon name="external-link" size={15} color={colors.brand} />
          </Pressable>
        </View>
      );
  }
}

const st = StyleSheet.create({
  body: { color: colors.fg, fontSize: 17, lineHeight: 24 },
  li: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  marker: { minWidth: 22, color: colors.muted },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.lineStrong, paddingLeft: space.md },
  code: { borderRadius: radius.md, backgroundColor: colors.elevated },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong, marginVertical: space.sm },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, borderRadius: radius.md, overflow: "hidden" },
  tr: { flexDirection: "row" },
  td: { flex: 1, padding: space.sm },
  callout: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.md, alignItems: "flex-start" },
  webCard: { gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, backgroundColor: colors.surface },
  webBtn: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  missing: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.neutralSoft },
});
