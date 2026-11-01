/**
 * M1 (1.10.9): React Query hooks for Contacts, saved addresses and the visit plan. Never cached on the phone: contacts
 * change on the server. The visit plan is kept on this phone only, as the web keeps it in the browser.
 */
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "./session";
import { kv } from "./kv";
import {
  contactsQuery, parsePlan, VISIT_PLAN_KEY,
  type CompanyDetailResponse, type ContactDetailResponse, type ContactListResponse, type PlaceEntity, type PlaceView, type VisitPlan, type VisitsResponse,
} from "./contacts";

export const contactKeys = {
  list: (q: string) => ["contacts", "list", q] as const,
  one: (id: string) => ["contacts", "one", id] as const,
  company: (id: string) => ["contacts", "company", id] as const,
  place: (type: PlaceEntity, id: string) => ["maps", "place", type, id] as const,
  visits: ["maps", "visits"] as const,
};

/** 401 and 403 mean this session may not open it; the screen shows a plain no access state. */
export const noAccess = (e: unknown) => !!e && typeof e === "object" && "status" in e && [401, 403].includes((e as { status: number }).status);
export const notFoundErr = (e: unknown) => !!e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404;
const retry = (n: number, e: unknown) => !noAccess(e) && !notFoundErr(e) && n < 2;

export function useContacts(q: string) {
  const { transport } = useSession();
  const query = contactsQuery(q);
  return useQuery({ queryKey: contactKeys.list(query), queryFn: () => transport.request<ContactListResponse>("GET", `/contacts${query}`), retry, placeholderData: (prev) => prev });
}

export function useContact(id: string | undefined) {
  const { transport } = useSession();
  return useQuery({ queryKey: contactKeys.one(id ?? ""), enabled: !!id, retry, queryFn: () => transport.request<ContactDetailResponse>("GET", `/contacts/${encodeURIComponent(id!)}`) });
}

export function useCompany(id: string | undefined | null) {
  const { transport } = useSession();
  return useQuery({ queryKey: contactKeys.company(id ?? ""), enabled: !!id, retry, queryFn: () => transport.request<CompanyDetailResponse>("GET", `/companies/${encodeURIComponent(id!)}`) });
}

/** The saved address of a contact or company (maps on only). Null when none is saved. */
export function usePlace(type: PlaceEntity, id: string | undefined, enabled: boolean) {
  const { transport } = useSession();
  return useQuery({
    queryKey: contactKeys.place(type, id ?? ""), enabled: enabled && !!id, retry,
    queryFn: async () => (await transport.request<{ place: PlaceView | null }>("GET", `/maps/places?type=${type}&id=${encodeURIComponent(id!)}`)).place,
  });
}

export function useVisits(enabled: boolean) {
  const { transport } = useSession();
  return useQuery({ queryKey: contactKeys.visits, enabled, retry, queryFn: () => transport.request<VisitsResponse>("GET", "/maps/visits") });
}

/** The visit plan saved on this phone. */
export function useVisitPlan(): [VisitPlan, (p: VisitPlan) => void, boolean] {
  const [plan, setPlanState] = useState<VisitPlan>({ ids: [] });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    kv().get(VISIT_PLAN_KEY).then((raw) => { if (live) { setPlanState(parsePlan(raw)); setReady(true); } }, () => { if (live) setReady(true); });
    return () => { live = false; };
  }, []);
  const setPlan = useCallback((p: VisitPlan) => { setPlanState(p); kv().set(VISIT_PLAN_KEY, JSON.stringify(p)).catch(() => undefined); }, []);
  return [plan, setPlan, ready];
}
