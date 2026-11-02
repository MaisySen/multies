/** M4: React Query hooks for Invoices, Scheduling and Links (read only, from the server each time). */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSession } from "./session";
import { noAccess, notFoundErr } from "./contacts-queries";
import type { Booking, InvoiceDetail, InvoiceList, SchedulingPage, ShortLink } from "./m4";

/** a=1&b=2 without empty values. Exported for tests. */
export function qs(p: Record<string, string | undefined>): string {
  return Object.entries(p).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
}
const retry = (k: number, e: unknown) => !noAccess(e) && !notFoundErr(e) && k < 2;
export const m4Keys = { invoices: ["invoices"] as const, invoice: (id: string) => ["invoice", id] as const, page: ["scheduling", "page"] as const, bookings: ["scheduling", "bookings"] as const, links: ["links"] as const };

export function useInvoices(state: string) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...m4Keys.invoices, state, mode], retry, networkMode: "always",
    queryFn: () => transport.request<InvoiceList>("GET", `/invoices/docs?${qs({ kind: "invoice", state, limit: "50" })}`) });
}
export function useInvoice(id: string) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...m4Keys.invoice(id), mode], retry, networkMode: "always", enabled: !!id,
    queryFn: () => transport.request<{ doc: InvoiceDetail }>("GET", `/invoices/docs/${encodeURIComponent(id)}`).then((r) => r.doc) });
}
export function useBookingPage() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...m4Keys.page, mode], retry, networkMode: "always", queryFn: () => transport.request<{ page: SchedulingPage | null }>("GET", "/scheduling/page").then((r) => r.page) });
}
export function useBookings() {
  const { transport, mode } = useSession();
  return useInfiniteQuery({ queryKey: [...m4Keys.bookings, mode], retry, networkMode: "always", initialPageParam: "",
    queryFn: ({ pageParam }) => transport.request<{ bookings: Booking[]; nextCursor: string | null }>("GET", `/scheduling/bookings?${qs({ upcoming: "1", status: "confirmed", limit: "50", cursor: pageParam })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined });
}
export function useLinks() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...m4Keys.links, mode], retry, networkMode: "always", queryFn: () => transport.request<{ links: ShortLink[]; base: string }>("GET", "/links") });
}
