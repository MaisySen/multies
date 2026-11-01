/**
 * M1 (1.10.9): Contacts, contact detail and Visits on the phone. Mock only: every request goes to the sample transport.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Linking, Platform } from "react-native";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import type { Transport } from "@/api/transport";
import { ApiError } from "@/api/errors";
import {
  contactSearchTerm, contactsQuery, directionsUrl, mapsAppFor, moveInPlan, parsePlan, plannedStops, routeLegs, routeUrls, shortestOrder, telUrl, togglePlan,
  type VisitCandidate,
} from "@/lib/contacts";
import { COMMANDS, createHandlers } from "@/lib/commands";
import Contacts from "@/app/contacts";
import ContactScreen from "@/app/contact/[id]";
import Visits from "@/app/visits";

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

configure({ asyncUtilTimeout: 30_000 });
jest.setTimeout(180_000);

async function wrap(ui: ReactNode, transport: Transport = new SampleTransport()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return await render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}

/** A transport that answers one path prefix with an error and sends the rest to the sample workspace. */
function failing(prefix: string, status: number, extra: Record<string, unknown> = {}): Transport {
  const s = new SampleTransport();
  return {
    kind: "sample",
    request: async <T,>(m: Parameters<Transport["request"]>[0], p: string, b?: unknown) => {
      if (p === "/config" && Object.keys(extra).length) return { ...(await s.request<Record<string, unknown>>(m, p, b)), ...extra } as T;
      if (p.startsWith(prefix)) throw new ApiError(status, status === 403 ? "forbidden" : status === 404 ? "not_found" : "internal", status === 403 ? "You don't have access to that." : "Not found.");
      return s.request<T>(m, p, b);
    },
  };
}

const openSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
beforeEach(() => { mockPush.mockClear(); mockParams = {}; });
afterEach(async () => { await cleanup(); });

describe("contact search (the server's 50 byte LIKE limit)", () => {
  it("keeps short searches as typed, collapsing spaces", () => {
    expect(contactSearchTerm("  priya   raman ")).toBe("priya raman");
    expect(contactsQuery("")).toBe("?limit=100");
    expect(contactsQuery("tom")).toBe("?limit=100&q=tom");
  });
  it("cuts a 69 character search to whole characters within 46 bytes", () => {
    const long = "a".repeat(69);
    expect(contactSearchTerm(long)).toHaveLength(46);
    const emoji = "😀".repeat(20);
    const t = contactSearchTerm(emoji);
    expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(46);
    expect(t.length % 2).toBe(0);
    expect(new TextEncoder().encode(`%${contactSearchTerm("é".repeat(60))}%`).length).toBeLessThanOrEqual(50);
  });
});

describe("call and directions links", () => {
  it("makes a tel link from a typed number", () => {
    expect(telUrl("+61 412 555 018")).toBe("tel:+61412555018");
    expect(telUrl("(02) 9555 0142")).toBe("tel:0295550142");
    expect(telUrl("ext")).toBeNull();
    expect(telUrl(null)).toBeNull();
  });
  it("opens Apple Maps on iPhone and Google Maps elsewhere, using the map point when saved", () => {
    expect(mapsAppFor("ios")).toBe("apple");
    expect(mapsAppFor("android")).toBe("google");
    const p = { address: "12 Pier Street, Haymarket", lat: -33.8768, lon: 151.2023 };
    expect(directionsUrl(p, "apple")).toBe("https://maps.apple.com/?daddr=-33.876800%2C151.202300&dirflg=d");
    expect(directionsUrl({ address: "5 Bay Street" }, "google")).toBe("https://www.google.com/maps/dir/?api=1&destination=5%20Bay%20Street&travelmode=driving");
  });
  it("routes every stop in one link from where the phone is, and splits a long day at 10 points", () => {
    const stops = Array.from({ length: 12 }, (_, i) => ({ address: `Stop ${i + 1}` }));
    expect(routeLegs(stops.slice(0, 9))).toHaveLength(1);
    const legs = routeLegs(stops);
    expect(legs).toHaveLength(2);
    expect(legs[0].from).toBeNull();
    expect(legs[0].stops).toHaveLength(9);
    expect(legs[1].from).toBe(stops[8]);
    const [g] = routeUrls(stops.slice(0, 3), "google");
    expect(g).toBe("https://www.google.com/maps/dir/?api=1&destination=Stop%203&waypoints=Stop%201%7CStop%202&travelmode=driving");
    const [a] = routeUrls(stops.slice(0, 3), "apple");
    expect(a).toBe("https://maps.apple.com/?daddr=Stop%201+to:Stop%202+to:Stop%203&dirflg=d");
    expect(routeUrls(stops, "apple")[1]).toContain("saddr=Stop%209");
  });
});

describe("the visit plan", () => {
  const c = (id: string, lat: number | null, lon: number | null): VisitCandidate => ({ id, type: "contact", entityId: id, name: id, detail: "", address: id, lat, lon });
  it("reads a saved plan safely and drops stops that lost their address", () => {
    expect(parsePlan("not json")).toEqual({ ids: [] });
    expect(parsePlan(JSON.stringify({ ids: ["a", 3, "b"] }))).toEqual({ ids: ["a", "b"] });
    expect(plannedStops({ ids: ["b", "x", "a"] }, [c("a", 1, 1), c("b", 2, 2)]).map((s) => s.id)).toEqual(["b", "a"]);
  });
  it("adds up to the limit, moves and orders", () => {
    expect(togglePlan({ ids: ["a"] }, "b", 2)).toEqual({ ids: ["a", "b"] });
    expect(togglePlan({ ids: ["a", "b"] }, "c", 2)).toBe("full");
    expect(togglePlan({ ids: ["a", "b"] }, "a", 2)).toEqual({ ids: ["b"] });
    expect(moveInPlan({ ids: ["a", "b", "c"] }, "c", -1)).toEqual({ ids: ["a", "c", "b"] });
    expect(moveInPlan({ ids: ["a", "b"] }, "a", -1)).toEqual({ ids: ["a", "b"] });
    const order = shortestOrder([c("start", 0, 0), c("far", 0, 10), c("none", null, null), c("near", 0, 1)]).map((s) => s.id);
    expect(order).toEqual(["start", "near", "far", "none"]);
  });
});

describe("Contact detail", () => {
  it("shows email, phone, company and the address with directions", async () => {
    const open = openSpy; open.mockClear();
    mockParams = { id: "con_s1" };
    await wrap(<ContactScreen />);
    expect(await screen.findByTestId("contact-name")).toBeTruthy();
    expect(screen.getByText("Harbour Build")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("contact-email"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/compose", params: { to: "priya@harbourbuild.com.au" } });
    await fireEvent.press(screen.getByTestId("contact-phone"));
    expect(open).toHaveBeenCalledWith("tel:+61412555018");
    await fireEvent.press(await screen.findByTestId("contact-directions"));
    const app = mapsAppFor(Platform.OS);
    expect(open).toHaveBeenLastCalledWith(app === "apple" ? "https://maps.apple.com/?daddr=-33.876800%2C151.202300&dirflg=d" : "https://www.google.com/maps/dir/?api=1&destination=-33.876800%2C151.202300&travelmode=driving");
    expect(screen.getByTestId("contact-notes")).toBeTruthy();
  });
  it("says when no phone or address is saved", async () => {
    mockParams = { id: "con_s3" };
    await wrap(<ContactScreen />);
    expect(await screen.findByText("No phone number saved")).toBeTruthy();
    expect(await screen.findByText("No address saved")).toBeTruthy();
  });
  it("hides the address card when maps are off", async () => {
    mockParams = { id: "con_s1" };
    const first = await wrap(<ContactScreen />, failing("/maps", 404, { maps: false }));
    expect(await screen.findByTestId("contact-name")).toBeTruthy();
    expect(screen.queryByTestId("contact-address")).toBeNull();
    await first.unmount();
  });
  it("handles a missing contact", async () => {
    mockParams = { id: "con_nope" };
    await wrap(<ContactScreen />);
    expect(await screen.findByText("Contact not found")).toBeTruthy();
  });
});

describe("Visits", () => {
  it("adds stops, orders them and opens one route", async () => {
    const open = openSpy; open.mockClear();
    await wrap(<Visits />);
    expect(await screen.findByText("No stops yet")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("visit-pick-plc_s1"));
    await fireEvent.press(screen.getByTestId("visit-pick-plc_s2"));
    expect(await screen.findByTestId("visit-stop-plc_s2")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("visit-up-plc_s2"));
    await fireEvent.press(screen.getByTestId("visits-open-0"));
    expect(open).toHaveBeenCalledTimes(1);
    const url = open.mock.calls[0][0] as string;
    expect(url.indexOf("151.185500")).toBeLessThan(url.indexOf("151.202300"));
    await fireEvent.press(screen.getByTestId("visits-clear"));
    expect(await screen.findByText("No stops yet")).toBeTruthy();
  });
  it("says so when maps are off", async () => {
    await wrap(<Visits />, failing("/maps", 404, { maps: false }));
    expect(await screen.findByText("Maps are off")).toBeTruthy();
  });
});

describe("Contacts screen", () => {
  it("lists contacts, searches, and opens a contact", async () => {
    await wrap(<Contacts />);
    expect(await screen.findByText("Priya Raman")).toBeTruthy();
    expect(screen.getAllByText("accounts@supplyhub.com.au").length).toBeGreaterThan(0);
    expect(await screen.findByTestId("contacts-visits")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("contacts-search"), "tom");
    await waitFor(() => expect(screen.queryByText("Priya Raman")).toBeNull());
    await fireEvent.press(screen.getByTestId("contact-con_s2"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/contact/[id]", params: { id: "con_s2" } });
  });
  it("a 69 character search does not fail", async () => {
    await wrap(<Contacts />);
    await screen.findByText("Priya Raman");
    await fireEvent.changeText(screen.getByTestId("contacts-search"), "x".repeat(69));
    expect(await screen.findByText("No contacts match")).toBeTruthy();
    expect(screen.queryByText("Couldn't load contacts")).toBeNull();
  });
  it("shows the plain no access state on 403", async () => {
    await wrap(<Contacts />, failing("/contacts", 403));
    expect(await screen.findByText("You do not have access to this")).toBeTruthy();
  });
  it("hides Plan visits when maps are off", async () => {
    await wrap(<Contacts />, failing("/maps", 404, { maps: false }));
    expect(await screen.findByText("Priya Raman")).toBeTruthy();
    expect(screen.queryByTestId("contacts-visits")).toBeNull();
  });
});

describe("command sheet", () => {
  it("has Contacts and Plan visits", () => {
    const nav = jest.fn();
    const h = createHandlers({ navigate: nav, openWeb: jest.fn() } as unknown as Parameters<typeof createHandlers>[0]);
    expect(COMMANDS.some((c) => c.id === "contacts")).toBe(true);
    h.contacts({} as never); h.visits({} as never);
    expect(nav).toHaveBeenNthCalledWith(1, "/contacts");
    expect(nav).toHaveBeenNthCalledWith(2, "/visits");
  });
});
