/* global jest */
jest.mock("expo-secure-store", () => {
  const m = new Map();
  return {
    getItemAsync: jest.fn(async (k) => m.get(k) ?? null),
    setItemAsync: jest.fn(async (k, v) => { m.set(k, v); }),
    deleteItemAsync: jest.fn(async (k) => { m.delete(k); }),
  };
});
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async () => ({ granted: false })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: "ExponentPushToken[test]" })),
  scheduleNotificationAsync: jest.fn(async () => "id"),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
}));
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Medium: "medium" }, NotificationFeedbackType: { Success: "success" },
}));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn(async () => ({})) }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000000" }));
jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  const Feather = (props) => require("react").createElement(Text, { accessibilityElementsHidden: true }, props.name);
  Feather.glyphMap = {};
  return { Feather };
});
jest.setTimeout(15000);
