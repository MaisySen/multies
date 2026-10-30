import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { ActionSheet } from "./action-sheet";
import { Icon } from "./ui";
import { useTools } from "@/lib/queries";
import { toolIcon, toolsForFile } from "@/lib/tools";
import { tick } from "@/lib/haptics";
import { bytes } from "@/lib/format";
import type { Attachment } from "@/api/types";
import { colors, radius, space } from "@/theme";

/**
 * A mail attachment in the thread. When Tools are on and a tool takes this file, tapping it opens a sheet
 * of those tools (Compress, Convert to PDF, Redact and the rest); the tool runs straight on the stored
 * attachment, so nothing is uploaded from the phone.
 */
export function AttachmentRow({ a }: { a: Attachment }) {
  const tools = useTools();
  const [open, setOpen] = useState(false);
  const fits = tools.data && a.available !== false ? toolsForFile(tools.data.tools, a.filename, a.contentType) : [];
  const body = (
    <>
      <View style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
        <Icon name={a.contentType?.includes("pdf") ? "file-text" : "paperclip"} size={18} color={colors.brand} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "500" }} numberOfLines={1}>{a.filename}</Text>
        <Text style={{ color: colors.subtle, fontSize: 13 }}>{bytes(a.sizeBytes)}</Text>
      </View>
      {fits.length ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, minHeight: 30, borderRadius: radius.pill, backgroundColor: colors.brandSoft }}>
          <Icon name="wrench" size={14} color={colors.brand} />
          <Text style={{ color: colors.brand, fontSize: 13, fontWeight: "600" }}>Tools</Text>
        </View>
      ) : null}
    </>
  );
  const style = { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: colors.neutralSoft };
  if (!fits.length) return <View style={style} accessible accessibilityLabel={`Attachment ${a.filename}, ${bytes(a.sizeBytes)}`} testID={`attachment-${a.id}`}>{body}</View>;
  return (
    <>
      <Pressable onPress={() => { tick(); setOpen(true); }} accessibilityRole="button" accessibilityLabel={`Attachment ${a.filename}, ${bytes(a.sizeBytes)}`}
        accessibilityHint="Opens Tools for this file" testID={`attachment-${a.id}`} style={({ pressed }) => [style, pressed && { opacity: 0.7 }]}>
        {body}
      </Pressable>
      <ActionSheet visible={open} title="Tools" subtitle={a.filename} testID="attachment-tools"
        options={fits.map((t) => ({ id: t.op, label: t.label, icon: toolIcon(t.op) }))}
        onClose={() => setOpen(false)}
        onSelect={(op) => { setOpen(false); router.push({ pathname: "/tool/[op]", params: { op, attachment: a.id, name: a.filename } }); }} />
    </>
  );
}
