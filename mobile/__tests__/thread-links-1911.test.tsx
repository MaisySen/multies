import { Linking } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { colors } from "@/theme";

// 1.9.11: the thread screen from the owner's screenshot ("From this email", archive, star, trash) shows
// the mail body, the quoted text and HTML only mail with tappable links in the brand colour.
jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => ({ id: "m1" }), Stack: { Screen: () => null } }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

const addr = (address: string, name?: string) => ({ address, name: name ?? null });
const base = { threadId: "t1", mailboxId: "mbx", folder: "inbox", subject: "[MaisySen/nsw-transport-app] Run failed: CI - main", isRead: true, isStarred: false, hasAttachments: false,
  to: [addr("bidur@fintex.au")], cc: [], bcc: [], attachments: [], sentByAgentId: null, snippet: "", labels: [] };
const GITHUB = "View results: https://github.com/MaisySen/nsw-transport-app/actions/runs/40926009018\n\nFinished: 2026-10-29 18:00:17 UTC\n\n-- \nManage your GitHub Actions notifications here: https://github.com/settings/notifications";
const MESSAGES = [
  { ...base, id: "m0", from: addr("receipts@shop.example", "Shop"), date: "2026-10-29T10:00:00Z", text: "", html: '<p>Your receipt</p><p><a href="https://shop.example/orders/123456789/receipt?utm=mail">View receipt</a></p>' },
  { ...base, id: "m1", from: addr("notifications@github.com", "GitHub"), date: "2026-10-29T18:00:20Z", html: null,
    text: `${GITHUB}\n\nOn Tue, 28 Oct 2026, GitHub <notifications@github.com> wrote:\n> Earlier run: https://github.com/MaisySen/nsw-transport-app/actions/runs/40900000001` },
];
let mockThread: unknown;
jest.mock("@/lib/queries", () => ({
  useThread: () => ({ data: mockThread, isLoading: false, error: null, refetch: jest.fn() }),
  useAgents: () => ({ data: [] }),
  useMessageAction: () => ({ mutate: jest.fn(), isPending: false }),
  useTaskMutations: () => ({ fromEmail: { mutateAsync: jest.fn(), isPending: false } }),
}));
jest.mock("@/lib/offline", () => ({ useOffline: () => false, blockOffline: () => false }));
jest.mock("@/components/meetings", () => ({ StartMeetingButton: () => null }));

it("the thread screen links the body, the quoted text and HTML only mail", async () => {
  mockThread = { message: MESSAGES[1], thread: MESSAGES };
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
  const Thread = require("@/app/thread/[id]").default;
  const s = await render(<Thread />);
  expect(s.getByText("Make a task from this email")).toBeTruthy();
  const shown = () => s.getAllByRole("link").map((l) => (l.props.children as string).replace(/\u200b/g, ""));
  expect(shown()).toEqual(["github.com/\u2026/actions/runs/40926009018", "github.com/settings/notifications"]);
  for (const l of s.getAllByRole("link")) expect(l).toHaveStyle({ color: colors.brand, textDecorationLine: "underline" });
  await fireEvent.press(s.getAllByRole("link")[0]);
  expect(open).toHaveBeenLastCalledWith("https://github.com/MaisySen/nsw-transport-app/actions/runs/40926009018");
  // Quoted text: its link is tappable too once shown.
  await fireEvent.press(s.getByTestId("quoted-m1"));
  expect(shown()).toContain("github.com/\u2026/actions/runs/40900000001");
  // HTML only mail (folded above): open it and its link label opens the full address.
  await fireEvent.press(s.getByTestId("collapsed-m0"));
  const receipt = s.getAllByRole("link").find((l) => (l.props.children as string).replace(/\u200b/g, "").startsWith("shop.example"));
  expect(receipt).toBeTruthy();
  await fireEvent.press(receipt!);
  expect(open).toHaveBeenLastCalledWith("https://shop.example/orders/123456789/receipt?utm=mail");
});
