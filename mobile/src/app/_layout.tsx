import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import * as Notifications from "expo-notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "@/lib/session";
import { configureNotifications } from "@/lib/push";
import { extractPushData, routeForPush } from "@/lib/push-events";
import "@/lib/push-task";
import { SAMPLE_ONLY } from "@/config";
import { colors, scheme } from "@/theme";
import { useReduceMotion } from "@/lib/motion";
import { HeldSendBar } from "@/components/held-send-bar";
import { OtaProvider } from "@/lib/ota/provider";
import { useBiometricLock } from "@/lib/native-features";
import { nativeGestureHandler } from "@/lib/native-modules";
import { LockScreen } from "@/components/lock-screen";
import { QuickActionsHost, QuickToastHost } from "@/components/quick-actions";

SplashScreen.preventAutoHideAsync().catch(() => {});
if (Platform.OS !== "web") configureNotifications();

export default function RootLayout() {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: (n, err) => n < 2 && (err as { status?: number }).status !== 401, staleTime: 15_000 } },
  }));
  // R37: gesture handler root on 1.10.0 builds (a plain View where the module is missing).
  const GH = nativeGestureHandler();
  const Root = GH ? GH.GestureHandlerRootView : View;
  return (
    <Root style={{ flex: 1 }}>
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <SessionProvider initialMode={SAMPLE_ONLY && process.env.EXPO_PUBLIC_AUTO_SAMPLE === "1" ? "sample" : undefined}>
          <StatusBar style={scheme === "light" ? "dark" : "light"} />
          <OtaProvider>
            <Navigator client={client} />
          </OtaProvider>
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
    </Root>
  );
}

function Navigator({ client }: { client: QueryClient }) {
  const { status, mode } = useSession();
  const reduceMotion = useReduceMotion();
  // R37: Face ID or fingerprint unlock, when the person turned it on in Settings.
  const lock = useBiometricLock(status === "signedIn");

  useEffect(() => { if (status !== "loading") SplashScreen.hideAsync().catch(() => {}); }, [status]);
  // Never show one account's mail to another session.
  useEffect(() => { client.clear(); }, [mode, status === "signedOut", client]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tapping a notification opens the screen it is about: a local one carries its url, a server
  // push carries { type, id }. A tap that launched the app is read once sign in is restored.
  useEffect(() => {
    if (Platform.OS === "web" || status !== "signedIn") return;
    const open = (r: Notifications.NotificationResponse | null) => {
      if (!r) return;
      const data = r.notification.request.content.data as Record<string, unknown> | undefined;
      const push = extractPushData(data) ?? extractPushData(r.notification.request.trigger);
      const url = typeof data?.url === "string" ? data.url : push ? routeForPush(push) : null;
      if (url && url.startsWith("/")) router.push(url as never);
    };
    Notifications.getLastNotificationResponseAsync().then((r) => { open(r); Notifications.clearLastNotificationResponseAsync?.().catch(() => {}); }).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [status]);

  if (status === "loading") return null;
  const signedIn = status === "signedIn";
  return (
    <>
    <Stack screenOptions={{
      headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.fg, headerTitleStyle: { color: colors.fg },
      contentStyle: { backgroundColor: colors.bg }, headerShadowVisible: false, headerBackButtonDisplayMode: "minimal",
      animation: reduceMotion ? "none" : "default",
    }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="two-factor" options={{ title: "Two step sign in" }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="thread/[id]" options={{ title: "" }} />
        <Stack.Screen name="compose" options={{ presentation: "modal", title: "New message" }} />
        <Stack.Screen name="search" options={{ title: "Search" }} />
        <Stack.Screen name="approval/[id]" options={{ title: "Review message" }} />
        <Stack.Screen name="task/[id]" options={{ title: "Task" }} />
        <Stack.Screen name="task/new" options={{ presentation: "modal", title: "New task" }} />
        <Stack.Screen name="meetings" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "Meetings" }} />
        <Stack.Screen name="portfolio" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "Portfolio" }} />
        <Stack.Screen name="workspaces" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "Workspaces" }} />
        {/* 1.10.6: Social keeps a fixed standard header (no large title): its parts and filters are pinned under it and
            only the list below scrolls, so nothing slides under the header. See __tests__/social-1106.test.tsx. */}
        <Stack.Screen name="social" options={{ headerLargeTitle: false, title: "Social" }} />
        <Stack.Screen name="social-inbox/[id]" options={{ headerLargeTitle: false, title: "Conversation" }} />
        <Stack.Screen name="social-post/[id]" options={{ headerLargeTitle: false, title: "Post" }} />
        <Stack.Screen name="social-posted/[id]" options={{ headerLargeTitle: false, title: "", headerBackVisible: false, gestureEnabled: false }} />
        <Stack.Screen name="deals" options={{ headerLargeTitle: false, title: "Deals" }} />
        <Stack.Screen name="deal/[id]" options={{ headerLargeTitle: false, title: "Deal" }} />
        <Stack.Screen name="expenses" options={{ headerLargeTitle: false, title: "Expenses" }} />
        <Stack.Screen name="expense/[id]" options={{ headerLargeTitle: false, title: "Expense" }} />
        <Stack.Screen name="more/[section]" options={{ headerLargeTitle: false, title: "More" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="review" options={{ title: "Approvals" }} />
        <Stack.Screen name="goals" options={{ title: "Goals" }} />
        <Stack.Screen name="forms" options={{ title: "Forms" }} />
        <Stack.Screen name="form/[id]" options={{ title: "Responses" }} />
        <Stack.Screen name="time" options={{ title: "Time" }} />
        <Stack.Screen name="automations" options={{ title: "Automations" }} />
        <Stack.Screen name="docs" options={{ headerLargeTitle: false, title: "Docs" }} />
        <Stack.Screen name="doc/[id]" options={{ title: "" }} />
        <Stack.Screen name="doc/comments/[id]" options={{ presentation: "modal", title: "Comments" }} />
        <Stack.Screen name="doc/share/[id]" options={{ presentation: "modal", title: "Share" }} />
        <Stack.Screen name="contacts" options={{ headerLargeTitle: false, title: "Contacts" }} />
        <Stack.Screen name="contact/[id]" options={{ headerLargeTitle: false, title: "Contact" }} />
        <Stack.Screen name="visits" options={{ headerLargeTitle: false, title: "Visits" }} />
        <Stack.Screen name="mail-merge" options={{ headerLargeTitle: false, title: "Mail merge" }} />
        <Stack.Screen name="newsletter/[id]" options={{ headerLargeTitle: false, title: "Newsletter" }} />
        <Stack.Screen name="journey/[id]" options={{ headerLargeTitle: false, title: "Journey" }} />
        <Stack.Screen name="mail-archive" options={{ headerLargeTitle: false, title: "Mail archive" }} />
        <Stack.Screen name="sync" options={{ headerLargeTitle: false, title: "Calendar and contacts sync" }} />
        <Stack.Screen name="people" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "People" }} />
        <Stack.Screen name="tools" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "Tools" }} />
        <Stack.Screen name="files" options={{ headerLargeTitle: false, title: "Files" }} />
        <Stack.Screen name="files-item/[id]" options={{ title: "File" }} />
        <Stack.Screen name="files-preview/[id]" options={{ presentation: "fullScreenModal", headerShown: false }} />
        <Stack.Screen name="tool/[op]" options={{ presentation: "modal", title: "Tool" }} />
        <Stack.Screen name="runs" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "Agent runs" }} />
        <Stack.Screen name="run/[id]" options={{ title: "Run" }} />
        <Stack.Screen name="chat/[id]" options={{ title: "" }} />
        <Stack.Screen name="chat/thread/[id]" options={{ title: "Thread" }} />
        <Stack.Screen name="chat/message/[id]" options={{ title: "" }} />
        <Stack.Screen name="chat/new" options={{ presentation: "modal", title: "New message" }} />
        <Stack.Screen name="notifications" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "Notifications" }} />
        <Stack.Screen name="notification-settings" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "Notification settings" }} />
        <Stack.Screen name="delete-account" options={{ title: "Delete account" }} />
        <Stack.Screen name="blocked" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "Blocked people" }} />
        <Stack.Screen name="email-setup" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "Email addresses" }} />
        <Stack.Screen name="connect-mailbox" options={{ title: "Connect your email" }} />
        <Stack.Screen name="free-address" options={{ title: "Free address" }} />
        <Stack.Screen name="mail-settings" options={{ headerLargeTitle: true, headerLargeTitleShadowVisible: false, headerLargeTitleStyle: { color: colors.fg }, title: "Mail" }} />
        <Stack.Screen name="mail-rule/[id]" options={{ title: "Rule" }} />
      </Stack.Protected>
    </Stack>
    {signedIn && <HeldSendBar />}
    {signedIn ? <QuickActionsHost /> : null}
    <QuickToastHost />
    {signedIn && lock.locked ? <LockScreen onUnlock={lock.unlock} /> : null}
    </>
  );
}
