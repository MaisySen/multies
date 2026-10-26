import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { router, Stack } from "expo-router";
import { Button, EmptyState, Icon, Loading } from "@/components/ui";
import { useClaimFreeAddress, useFreeAddress, useFreeAddressCheck } from "@/lib/queries";
import { cleanLocalPart, localPartProblem } from "@/lib/mail-connect";
import { colors, font, radius, space } from "@/theme";

/**
 * A free personal address on the Multies shared domain (mail.multies.si): one field, prefilled
 * with a suggestion, one button. The server checks the name is free and allowed, and its words
 * are shown as they come ("is taken", "kept for Multies", the daily limits).
 */
export default function FreeAddress() {
  const info = useFreeAddress();
  const claim = useClaimFreeAddress();
  const [local, setLocal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const offer = info.data && info.data.enabled ? info.data : null;
  const typed = cleanLocalPart(local ?? offer?.suggestion ?? "");
  // R26: the server says whether the name is free while the person types (reads only).
  const check = useFreeAddressCheck(typed, !!offer?.available && !offer.addresses.length && !taken && !localPartProblem(typed));

  if (info.isPending) return <Loading rows={3} />;
  if (info.error) return <EmptyState icon="alert-circle" title="Couldn't load free addresses" body={info.error.message} action={<Button label="Try again" variant="secondary" onPress={() => info.refetch()} />} />;
  const d = info.data;
  if (!d.enabled) return <EmptyState icon="at-sign" title="No free addresses here" body="This server doesn't offer free addresses. Connect your existing email or add your own domain instead." />;
  const mine = taken ?? d.addresses[0]?.address;

  if (mine) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: space.xl, gap: space.lg, alignItems: "center", justifyContent: "center" }} testID="free-address-done">
        <Stack.Screen options={{ title: "Your free address" }} />
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.okSoft, alignItems: "center", justifyContent: "center" }}>
          <Icon name="check" size={28} color={colors.ok} />
        </View>
        <Text style={[font.heading, { textAlign: "center" }]} testID="free-address-value" selectable>{mine}</Text>
        <Text style={[font.small, { textAlign: "center", maxWidth: 320 }]}>
          {taken ? "It's yours. Send and receive straight away." : "This is your free address. Each person gets one."} Free addresses can send to up to {d.dailySends} people a day (fewer in the first week).
        </Text>
        <Button label="Open inbox" icon="inbox" testID="open-inbox" onPress={() => router.replace("/inbox")} style={{ alignSelf: "stretch" }} />
      </View>
    );
  }
  if (!d.available) return <EmptyState icon="at-sign" title="Not in a sample workspace" body="Sample workspaces can't take a real address. Create a free account first." />;

  const value = local ?? d.suggestion;
  const submit = () => {
    const v = cleanLocalPart(value);
    const problem = localPartProblem(v);
    if (problem) return setError(problem);
    setError(null);
    claim.mutate(v, {
      onSuccess: (r) => setTaken(r.mailbox.address),
      onError: (e) => setError((e as Error).message || "That didn't work. Try again."),
    });
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: "Free address" }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled" testID="free-address">
        <View style={{ gap: 4 }}>
          <Text style={font.heading}>Get a free @{d.domain} address</Text>
          <Text style={font.small}>Your own personal address, free. Send and receive straight away. You can connect your existing email or add your own domain any time.</Text>
        </View>
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }} nativeID="free-local-label">Address</Text>
          <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: error ? colors.bad : colors.line, minHeight: 48 }}>
            <TextInput value={value} testID="free-local" accessibilityLabel="Address" accessibilityLabelledBy="free-local-label"
              onChangeText={(t) => { setLocal(cleanLocalPart(t)); setError(null); }} autoCapitalize="none" autoCorrect={false} autoComplete="off" maxLength={40}
              placeholderTextColor={colors.subtle} selectionColor={colors.brand} returnKeyType="done" onSubmitEditing={submit}
              style={{ flex: 1, minWidth: 0, paddingHorizontal: space.md, paddingVertical: 12, fontSize: 16, color: colors.fg }} />
            <Text style={{ color: colors.subtle, fontSize: 16, paddingRight: space.md }} numberOfLines={1}>@{d.domain}</Text>
          </View>
          {error ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityLiveRegion="polite" testID="free-error">{error}</Text>
            : check.data && check.data.available ? <Text style={{ color: colors.ok, fontSize: 14 }} accessibilityLiveRegion="polite" testID="free-available">{check.data.address ?? `${typed}@${d.domain}`} is available</Text>
            : check.data && !check.data.available ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityLiveRegion="polite" testID="free-unavailable">{check.data.problem ?? "That name is taken. Try another."}</Text> : null}
        </View>
        <Button label="Get my address" icon="at-sign" testID="free-claim" loading={claim.isPending} disabled={claim.isPending} onPress={submit} />
        <Text style={font.tiny}>
          One per person. Free addresses can send to up to {d.dailySends} people a day (fewer in the first week), and outgoing mail is checked for spam. An address is never given to anyone else, even after it is deleted. Your own domain lifts the limits.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
