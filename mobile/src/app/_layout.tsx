import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "@/lib/session";
import { configureNotifications } from "@/lib/push";
import { SAMPLE_ONLY } from "@/config";
import { colors } from "@/theme";

SplashScreen.preventAutoHideAsync().catch(() => {});
if (Platform.OS !== "web") configureNotifications();

export default function RootLayout() {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: (n, err) => n < 2 && (err as { status?: number }).status !== 401, staleTime: 15_000 } },
  }));
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <SessionProvider initialMode={SAMPLE_ONLY && process.env.EXPO_PUBLIC_AUTO_SAMPLE === "1" ? "sample" : undefined}>
          <StatusBar style="light" />
          <Navigator client={client} />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function Navigator({ client }: { client: QueryClient }) {
  const { status, mode } = useSession();

  useEffect(() => { if (status !== "loading") SplashScreen.hideAsync().catch(() => {}); }, [status]);
  // Never show one account's mail to another session.
  useEffect(() => { client.clear(); }, [mode, status === "signedOut", client]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tapping a notification opens the screen it is about.
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      const url = r.notification.request.content.data?.url;
      if (typeof url === "string" && url.startsWith("/")) router.push(url as never);
    });
    return () => sub.remove();
  }, []);

  if (status === "loading") return null;
  const signedIn = status === "signedIn";
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.fg, headerTitleStyle: { color: colors.fg },
      contentStyle: { backgroundColor: colors.bg }, headerShadowVisible: false, headerBackButtonDisplayMode: "minimal",
    }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="two-factor" options={{ title: "Two step sign in" }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="thread/[id]" options={{ title: "" }} />
        <Stack.Screen name="compose" options={{ presentation: "modal", title: "New message" }} />
        <Stack.Screen name="search" options={{ title: "Search mail" }} />
        <Stack.Screen name="approval/[id]" options={{ title: "Review message" }} />
        <Stack.Screen name="task/[id]" options={{ title: "Task" }} />
        <Stack.Screen name="task/new" options={{ presentation: "modal", title: "New task" }} />
        <Stack.Screen name="delete-account" options={{ title: "Delete account" }} />
      </Stack.Protected>
    </Stack>
  );
}
