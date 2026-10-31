import { Linking, Text } from "react-native";
import { linkLabel, linkSegments } from "@/lib/mail-body";
import { tick } from "@/lib/haptics";
import { openLinkActions } from "@/lib/quick-actions";
import { colors } from "@/theme";

/**
 * Text with tappable links (1.9.11): web and email addresses in the brand colour, underlined, long
 * addresses shortened and broken between parts (linkLabel); a tap opens the full address in the
 * browser or the mail app. Put it inside a <Text> so the parent's font and colour apply to the rest.
 * 1.10.7: a long press on a link opens Open, Copy link and Share.
 */
export function LinkedText({ text, testID }: { text: string; testID?: string }) {
  return (
    <>
      {linkSegments(text).map((seg, i) =>
        seg.kind === "link" ? (
          <Text key={i} testID={testID ? `${testID}-link-${i}` : undefined} style={{ color: colors.brand, textDecorationLine: "underline" }}
            accessibilityRole="link" accessibilityHint={`${seg.url.replace(/^mailto:/i, "")}. Press and hold to copy or share.`} suppressHighlighting={false}
            onPress={() => { tick(); Linking.openURL(seg.url).catch(() => undefined); }} onLongPress={() => openLinkActions(seg.url)}>{linkLabel(seg)}</Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </>
  );
}
