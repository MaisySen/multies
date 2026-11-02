/**
 * M1 (1.10.9): the sample workspace's Contacts, Maps, Mail merge, Mail archive and Sync, in the server's shapes, so the
 * screens render on the web build and in tests with no server. Kept in memory only.
 */
import { ApiError } from "@/api/errors";
import type { ContactView, PlaceView, VisitCandidate } from "@/lib/contacts";

const iso = (t: number) => new Date(t).toISOString();

export interface M1WorkState {
  contacts: ContactView[];
  places: PlaceView[];
  [key: string]: unknown;
}

export function sampleM1Work(now: number): M1WorkState {
  const day = 86_400_000;
  const co = (id: string, name: string, domain: string) => ({ id, name, domain });
  const acme = co("co_s1", "Harbour Build", "harbourbuild.com.au"), leaf = co("co_s2", "Greenleaf Cafe", "greenleaf.au");
  const mk = (id: string, name: string, email: string, phone: string | null, title: string | null, company: ContactView["company"], ago: number, notes: string | null = null): ContactView => ({
    id, name, email, phone, title, notes, source: "mail", company, companyId: company?.id ?? null, messageCount: 4,
    firstContactAt: iso(now - 40 * day), lastContactAt: iso(now - ago * day), createdAt: iso(now - 40 * day), updatedAt: iso(now - ago * day),
  });
  const contacts = [
    mk("con_s1", "Priya Raman", "priya@harbourbuild.com.au", "+61 412 555 018", "Site manager", acme, 0, "Prefers a call before 9 am. Gate code is at reception."),
    mk("con_s2", "Tom Nguyen", "tom@greenleaf.au", "02 9555 0142", "Owner", leaf, 1),
    mk("con_s3", "Sarah Mitchell", "sarah.mitchell@example.com", null, null, null, 3),
    mk("con_s4", "Daniel Okafor", "daniel@harbourbuild.com.au", "+61 400 555 777", "Estimator", acme, 6),
    mk("con_s5", "", "accounts@supplyhub.com.au", null, null, null, 9),
  ];
  const pl = (id: string, entityType: "contact" | "company", entityId: string, address: string, lat: number | null, lon: number | null): PlaceView =>
    ({ id, entityType, entityId, address, lat, lon, updatedAt: iso(now - day) });
  const places = [
    pl("plc_s1", "contact", "con_s1", "12 Pier Street, Haymarket NSW 2000, Australia", -33.8768, 151.2023),
    pl("plc_s2", "contact", "con_s2", "88 Glebe Point Road, Glebe NSW 2037, Australia", -33.8794, 151.1855),
    pl("plc_s3", "company", "co_s1", "200 George Street, Sydney NSW 2000, Australia", -33.8636, 151.2078),
    pl("plc_s4", "contact", "con_s4", "5 Bay Street, Double Bay NSW 2028, Australia", null, null),
  ];
  return { contacts, places };
}

function visitCandidates(s: M1WorkState): VisitCandidate[] {
  const out: VisitCandidate[] = [];
  for (const p of s.places) {
    if (p.entityType === "contact") {
      const c = s.contacts.find((x) => x.id === p.entityId); if (!c) continue;
      out.push({ id: p.id, type: "contact", entityId: c.id, name: c.name || c.email, detail: c.email, address: p.address, lat: p.lat, lon: p.lon });
    } else if (p.entityType === "company") {
      const c = s.contacts.find((x) => x.company?.id === p.entityId)?.company; if (!c) continue;
      out.push({ id: p.id, type: "company", entityId: c.id, name: c.name, detail: "Company", address: p.address, lat: p.lat, lon: p.lon });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Answers the routes this part owns, or undefined to let the next sample route try. */
export function m1WorkRoute(s: M1WorkState, method: string, path: string, params: Record<string, string>, body: unknown, now: number): unknown {
  void body; void now;
  const parts = path.split("/").filter(Boolean);
  if (method === "GET" && path === "/config") {
    return { maps: true, mailArchive: true, davSync: true, filesPlus: true, docsPlus: true, searchR98: true, mergePlus: true };
  }
  if (parts[0] === "contacts" && method === "GET") {
    if (parts.length === 1) {
      const q = (params.q ?? "").toLowerCase();
      if (new TextEncoder().encode(`%${q}%`).length > 50) throw new ApiError(500, "internal", "Something went wrong on our side.");
      const list = s.contacts.filter((c) => !q || c.name.toLowerCase().includes(q) || c.email.includes(q));
      const limit = Number(params.limit ?? 100);
      return { contacts: list.slice(0, limit), total: list.length };
    }
    const c = s.contacts.find((x) => x.id === decodeURIComponent(parts[1]));
    if (!c) throw new ApiError(404, "not_found", "Contact not found.");
    return { contact: c, threads: [], tasks: [], deals: [], timeline: [], activity: [] };
  }
  if (parts[0] === "companies" && method === "GET" && parts.length === 2) {
    const people = s.contacts.filter((x) => x.company?.id === parts[1]);
    if (!people.length) throw new ApiError(404, "not_found", "Company not found.");
    const co = people[0].company!;
    return { company: { ...co, notes: null }, contacts: people, deals: [] };
  }
  if (parts[0] === "maps") {
    if (method === "GET" && parts[1] === "places") {
      return { place: s.places.find((p) => p.entityType === params.type && p.entityId === params.id) ?? null };
    }
    if (method === "GET" && parts[1] === "visits") return { candidates: visitCandidates(s), limit: 25 };
  }
  return undefined;
}
