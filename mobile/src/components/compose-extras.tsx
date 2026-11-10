/**
 * MPAR3: Compose extras on the phone, as on the web's composer: attach from Files (the document picker already in the
 * store builds), saved replies, send later and send securely. Each fails soft: a missing picker or crypto module
 * hides its button and the plain composer keeps working.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as Crypto from "expo-crypto";
import { Button, Field, Icon, type IconName } from "@/components/ui";
import { Label, Note, Pill, Sheet } from "@/components/mpar3-ui";
import { colors, font, lh, radius, space, TOUCH } from "@/theme";
import { tr } from "@/i18n";
import { stripDataUrl } from "@/lib/chat-files";
import { success, tick, warning } from "@/lib/haptics";
import {
  SECRET_EXPIRY, SECRET_MAX_TEXT, SECRET_VIEWS, SEND_LATER_PRESETS, addDays, composeFileProblem, dayKey, encryptSecretText, localWhen, secretLink,
  type ComposeFile, type SealFn, type SendLaterPreset, type Snippet,
} from "@/lib/mpar3";
import { isOff, useCreateSecret, useRenderSnippet, useSnippets } from "@/lib/mpar3-queries";

/** AES GCM through expo-crypto (in the store builds; WebCrypto on the web build), or null where it is missing. */
export function secureSeal(): SealFn | null {
  try {
    const C = Crypto as unknown as { AESEncryptionKey?: { import?: (b: Uint8Array) => Promise<unknown> }; aesEncryptAsync?: (p: Uint8Array, k: unknown, o: unknown) => Promise<{ combined: () => Promise<Uint8Array> }> };
    if (typeof C.AESEncryptionKey?.import !== "function" || typeof C.aesEncryptAsync !== "function") return null;
    return async (plain, key, iv) => {
      const k = await C.AESEncryptionKey!.import!(key);
      const sealed = await C.aesEncryptAsync!(plain, k, { nonce: { bytes: iv }, tagLength: 16 });
      return new Uint8Array(await sealed.combined());
    };
  } catch { return null; }
}
const random = (n: number) => Crypto.getRandomBytes(n);

/** Opens the Files picker; returns the files that fit and one message about any that did not. */
export async function pickComposeFiles(already: ComposeFile[]): Promise<{ files: ComposeFile[]; problem: string | null }> {
  let res: DocumentPicker.DocumentPickerResult;
  try { res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: "*/*" }); }
  catch { return { files: [], problem: tr("m.compose3.picker_missing") }; }
  if (res.canceled || !res.assets?.length) return { files: [], problem: null };
  const out: ComposeFile[] = [];
  let problem: string | null = null;
  for (const a of res.assets) {
    const why = composeFileProblem(a, [...already, ...out]);
    if (why) { problem = problem ?? why; continue; }
    out.push({ id: `${Date.now()}-${out.length}-${a.name}`, name: a.name, size: a.size, mimeType: a.mimeType, uri: a.uri, base64: a.base64 });
  }
  return { files: out, problem };
}

/** A picked file as base64 for POST /api/mail/send (attachments: [{ filename, contentType, data }]). */
export async function fileData(f: ComposeFile, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<{ filename: string; contentType: string; data: string }> {
  let b64 = f.base64 ? stripDataUrl(f.base64) : "";
  if (!b64) {
    const blob = await (await fetchImpl(f.uri)).blob();
    b64 = stripDataUrl(await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result ?? ""));
      r.onerror = () => reject(new Error(tr("m.compose3.read_failed", { name: f.name })));
      r.readAsDataURL(blob);
    }));
  }
  if (!b64) throw new Error(tr("m.compose3.read_failed", { name: f.name }));
  return { filename: f.name, contentType: f.mimeType || "application/octet-stream", data: b64 };
}

export function ExtraButton({ icon, label, onPress, testID, disabled }: { icon: IconName; label: string; onPress: () => void; testID?: string; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} testID={testID}
      style={({ pressed }) => ({ minHeight: TOUCH, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, borderRadius: TOUCH / 2, backgroundColor: colors.neutralSoft, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 })}>
      <Icon name={icon} size={17} color={colors.fg} />
      <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600", lineHeight: lh(19) }}>{label}</Text>
    </Pressable>
  );
}

/** The saved replies list: tapping one fills it in for this recipient (POST /api/mail/snippets/:id/render). */
export function SavedRepliesSheet({ visible, onClose, to, mailboxId, onPick }: {
  visible: boolean; onClose: () => void; to: string; mailboxId?: string; onPick: (r: { body: string; subject: string }) => void;
}) {
  const list = useSnippets(visible);
  const render = useRenderSnippet();
  const [err, setErr] = useState<string | null>(null);
  const pick = async (s: Snippet) => {
    tick(); setErr(null);
    try { const r = await render.mutateAsync({ id: s.id, to: to.split(",")[0]?.trim(), mailboxId }); onPick({ body: r.body, subject: r.subject ?? "" }); success(); onClose(); }
    catch (x) { warning(); setErr((x as Error).message || tr("m.compose3.reply_failed")); }
  };
  const items = list.data ?? [];
  return (
    <Sheet visible={visible} onClose={onClose} title={tr("m.compose3.saved_replies")} subtitle={tr("m.compose3.saved_sub")} testID="saved-replies-sheet">
      {list.isLoading ? <Text style={font.small}>{tr("m.compose3.loading")}</Text> : list.error ? <Note tone={isOff(list.error) ? undefined : "bad"}>{isOff(list.error) ? tr("m.compose3.saved_off") : tr("m.compose3.saved_failed")}</Note>
        : !items.length ? <Note>{tr("m.compose3.saved_none")}</Note> : (
        <View style={{ backgroundColor: colors.bg, borderRadius: 14, overflow: "hidden" }}>
          {items.map((s, i) => (
            <Pressable key={s.id} onPress={() => pick(s)} accessibilityRole="button" accessibilityLabel={s.name} testID={`snippet-${s.id}`}
              style={({ pressed }) => ({ minHeight: 56, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2, borderTopWidth: i ? 1 : 0, borderTopColor: colors.line, backgroundColor: pressed ? colors.hover : "transparent" })}>
              <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "600", lineHeight: lh(21) }} numberOfLines={1}>{s.name}</Text>
              <Text style={{ color: colors.subtle, fontSize: 13, lineHeight: lh(18) }} numberOfLines={2}>{s.body}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {err ? <Note tone="bad">{err}</Note> : null}
    </Sheet>
  );
}

/** Send later: Later today, Tomorrow morning, Next week, or a day and time typed in. */
export function SendLaterSheet({ visible, onClose, onSchedule, busy, blocked }: {
  visible: boolean; onClose: () => void; onSchedule: (when: { preset: SendLaterPreset } | { at: string }) => Promise<void>; busy: boolean; blocked: string | null;
}) {
  const [day, setDay] = useState(() => dayKey(addDays(new Date(), 1)));
  const [time, setTime] = useState("09:00");
  const [err, setErr] = useState<string | null>(null);
  const go = async (when: { preset: SendLaterPreset } | { at: string }) => {
    setErr(null);
    try { await onSchedule(when); } catch (x) { warning(); setErr((x as Error).message || tr("m.compose3.schedule_failed")); }
  };
  const custom = () => { const r = localWhen(day, time); if ("error" in r) return setErr(r.error); void go(r); };
  return (
    <Sheet visible={visible} onClose={onClose} title={tr("m.compose3.send_later")} subtitle={tr("m.compose3.later_sub")} testID="send-later-sheet">
      {blocked ? <Note tone="bad">{blocked}</Note> : (
        <>
          <View style={{ gap: space.sm }}>
            {SEND_LATER_PRESETS.map((p) => (
              <Pressable key={p} onPress={() => { tick(); void go({ preset: p }); }} disabled={busy} accessibilityRole="button" accessibilityLabel={tr(`m.compose3.preset_${p}`)} testID={`later-${p}`}
                style={({ pressed }) => ({ minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: pressed ? colors.hover : colors.bg })}>
                <Icon name="clock" size={20} color={colors.brand} />
                <Text style={{ flex: 1, color: colors.fg, fontSize: 16, lineHeight: lh(21) }}>{tr(`m.compose3.preset_${p}`)}</Text>
              </Pressable>
            ))}
          </View>
          <Label>{tr("m.compose3.pick_time")}</Label>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <View style={{ flex: 3 }}><Field label={tr("m.cal.date")} value={day} onChangeText={setDay} autoCapitalize="none" placeholder="2026-11-05" testID="later-day" /></View>
            <View style={{ flex: 2 }}><Field label={tr("m.cal.time")} value={time} onChangeText={setTime} autoCapitalize="none" placeholder="09:00" testID="later-time" /></View>
          </View>
          <Button label={tr("m.compose3.schedule")} icon="clock" onPress={custom} loading={busy} testID="later-custom" />
          <Note>{tr("m.compose3.later_note")}</Note>
        </>
      )}
      {err ? <Note tone="bad">{err}</Note> : null}
    </Sheet>
  );
}

/** Send securely: the words are locked on this phone into a secret link, and the link goes in the email instead. */
export function SecureSheet({ visible, onClose, initial, onLink }: { visible: boolean; onClose: () => void; initial: string; onLink: (link: string) => void }) {
  const [text, setText] = useState(initial);
  const [views, setViews] = useState<number>(1);
  const [expires, setExpires] = useState<number>(7 * 86_400);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) { setSeen(initial); setText(initial); }
  const create = useCreateSecret();
  const seal = secureSeal();
  const make = async () => {
    setErr(null);
    if (!text.trim()) return setErr(tr("m.compose3.secret_empty"));
    if (text.length > SECRET_MAX_TEXT) return setErr(tr("m.compose3.secret_long", { n: SECRET_MAX_TEXT }));
    if (!seal) return setErr(tr("m.compose3.secret_missing"));
    setBusy(true);
    try {
      const { ciphertext, key } = await encryptSecretText(text, seal, random);
      const r = await create.mutateAsync({ ciphertext, label: null, maxViews: views, expiresInSeconds: expires });
      if (!r.secret.url) throw new Error(tr("m.compose3.secret_failed"));
      onLink(secretLink(r.secret.url, key)); success(); onClose();
    } catch (x) { warning(); setErr((x as Error).message || tr("m.compose3.secret_failed")); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={tr("m.compose3.send_securely")} subtitle={tr("m.compose3.secure_sub")} testID="secure-sheet"
      footer={<Button label={tr("m.compose3.secure_make")} icon="lock" onPress={make} loading={busy} testID="secure-make" />}>
      <Field label={tr("m.compose3.secret")} value={text} onChangeText={setText} multiline placeholder={tr("m.compose3.secret_placeholder")} testID="secure-text"
        style={{ minHeight: 96, textAlignVertical: "top" }} autoCapitalize="none" autoCorrect={false} />
      <Label>{tr("m.compose3.views")}</Label>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {SECRET_VIEWS.map((n) => <Pill key={n} label={tr("m.compose3.n_views", { count: n })} selected={views === n} onPress={() => setViews(n)} testID={`views-${n}`} />)}
      </View>
      <Label>{tr("m.compose3.expires")}</Label>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {SECRET_EXPIRY.map((sec) => <Pill key={sec} label={tr(`m.compose3.expires_${sec}`)} selected={expires === sec} onPress={() => setExpires(sec)} testID={`expires-${sec}`} />)}
      </View>
      <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
        <Icon name="shield" size={16} color={colors.ok} />
        <View style={{ flex: 1 }}><Note>{tr("m.compose3.secure_note")}</Note></View>
      </View>
      {err ? <Note tone="bad">{err}</Note> : null}
    </Sheet>
  );
}
