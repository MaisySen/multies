import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { ActionSheet } from "./action-sheet";
import { Icon } from "./ui";
import { useTools } from "@/lib/queries";
import { toolsForFile } from "@/lib/tools";
import { buildEntries } from "@/lib/tool-directory";
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
  const [all, setAll] = useState(false);
  const fits = tools.data && a.available !== false ? toolsForFile(tools.data.tools, a.filename, a.contentType) : [];
  // Tools P2: the most useful few first, then More tools for the rest; names and icons as on the Tools screen.
  const looks = new Map((tools.data ? buildEntries(tools.data) : []).map((e) => [e.key, e]));
  const ranked = [...fits].sort((x, y) => (FIRST.indexOf(x.op) + 1 || 99) - (FIRST.indexOf(y.op) + 1 || 99));
  const listed = all || ranked.length <= 6 ? ranked : ranked.slice(0, 5);
  const sheetOptions = [
    ...listed.map((t) => ({ id: t.op, label: looks.get(t.op)?.name ?? t.label, icon: looks.get(t.op)?.icon ?? ("wrench" as const) })),
    ...(listed.length < ranked.length ? [{ id: "__more", label: `More tools (${ranked.length - listed.length})`, icon: "more-horizontal" as const }] : []),
  ];
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
      <Pressable onPress={() => { tick(); setAll(false); setOpen(true); }} accessibilityRole="button" accessibilityLabel={`Attachment ${a.filename}, ${bytes(a.sizeBytes)}`}
        accessibilityHint="Opens Tools for this file" testID={`attachment-${a.id}`} style={({ pressed }) => [style, pressed && { opacity: 0.7 }]}>
        {body}
      </Pressable>
      <ActionSheet visible={open} title="Tools" subtitle={a.filename} testID="attachment-tools"
        options={sheetOptions}
        onClose={() => setOpen(false)}
        onSelect={(op) => { if (op === "__more") { tick(); setAll(true); return; } setOpen(false); router.push({ pathname: "/tool/[op]", params: { op, attachment: a.id, name: a.filename } }); }} />
    </>
  );
}

/** The tools most people want for an attachment, in this order. */
const FIRST = ["compress", "pdf-to-docx", "convert", "ocr", "protect", "pii-find", "stamp", "watermark", "redact", "unlock", "pdf-tables", "excel-clean", "to-pdf", "images-to-pdf", "scrub", "split", "rotate", "to-jpeg", "pdf-to"];
