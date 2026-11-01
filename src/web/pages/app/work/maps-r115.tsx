/**
 * R115 maps (MAPS_R115): address search, the address card on contacts, companies and the booking page, and the
 * Visits tab that orders a day of visits and opens it in the phone's maps app. Lookups go through our server, which
 * keeps to the free services' usage rules; nothing here needs a key.
 */
import { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { lazyPage } from "@/web/components/lazy-page";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconArrowDown, IconArrowUp, IconArrowUpRight, IconClose, IconCopy, IconEdit, IconMapPin, IconPlus, IconRefresh, IconSparkle, IconTrash } from "@/web/components/ui/icon";
import { ApiError, api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Input } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import {
  MAP_ATTRIBUTION, MAX_VISIT_STOPS, bestHint, highlightAfterResults, directionsLinks, orderStops, pathKm, routeLinks, shortAddress, validPoint, type GeoPoint, type GeoResult,
} from "@/shared/maps-r115";

// The map code loads only when a map is shown; if it cannot load, the address and links still work.
const MapView = lazyPage(() => import("./map-view-r115"), "MapView", { quiet: true });

export function useMapsOn() {
  const config = useQuery({ queryKey: ["config"], queryFn: () => api.get<{ maps?: boolean }>("/config"), staleTime: 300_000 });
  return !!config.data?.maps;
}

export type PlaceType = "contact" | "company" | "scheduling_page";
export interface Place { id: string; entityType: PlaceType; entityId: string; address: string; lat: number | null; lon: number | null }
interface Picked { address: string; lat: number | null; lon: number | null }

const linkCls = "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11";

function MapBox({ points, line, className, label }: { points: { lat: number; lon: number; label: string; n?: number }[]; line?: boolean; className?: string; label: string }) {
  return (
    <Suspense fallback={<Skeleton className={cn("rounded-xl", className)} />}>
      <MapView points={points} line={line} className={className} label={label} />
    </Suspense>
  );
}

/**
 * Address search box (ARIA combobox). Suggestions appear after a short pause; Enter runs a full search. Whatever is
 * typed can be kept as is, so a place the map services do not know still saves.
 */
export function AddressField({ initial = "", onChange, label, autoFocus, placeholder = "Start typing an address" }: {
  initial?: string; onChange: (p: Picked) => void; label: string; autoFocus?: boolean; placeholder?: string;
}) {
  const [text, setText] = useState(initial);
  const [results, setResults] = useState<GeoResult[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [state, setState] = useState<"idle" | "loading" | "busy" | "none" | "error">("idle");
  const [message, setMessage] = useState("");
  const seq = useRef(0);
  const activeAddress = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();
  const listId = `${id}-list`;

  const search = async (q: string, mode: "suggest" | "find") => {
    const n = ++seq.current;
    setState("loading"); setOpen(true);
    try {
      const r = await api.get<{ results: GeoResult[]; busy?: boolean }>(`/maps/lookup?mode=${mode}&q=${encodeURIComponent(q)}`);
      if (n !== seq.current) return;
      // Keep the row the person highlighted (found again by its address) when newer results land; otherwise nothing is
      // highlighted until ArrowDown, so ArrowDown then Enter always saves the first row they saw.
      const keep = highlightAfterResults(activeAddress.current, r.results);
      setResults(r.results); setActive(keep);
      setState(r.busy ? "busy" : r.results.length ? "idle" : "none");
    } catch (e) {
      if (n !== seq.current) return;
      setResults([]); setState("error");
      setMessage(e instanceof ApiError ? e.message : "Address search did not answer. Try again, or keep the address as typed.");
    }
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const type = (v: string) => {
    setText(v); onChange({ address: v, lat: null, lon: null }); setActive(-1); activeAddress.current = null;
    clearTimeout(timer.current);
    if (v.trim().length < 4) { seq.current++; setOpen(false); setResults([]); setState("idle"); return; }
    timer.current = setTimeout(() => void search(v, "suggest"), 600);
  };
  const pick = (r: GeoResult) => {
    setText(r.address); setOpen(false); setResults([]); setState("idle");
    onChange({ address: r.address, lat: r.lat, lon: r.lon });
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && results.length) { e.preventDefault(); setOpen(true); setActive((a) => (a + 1) % results.length); }
    else if (e.key === "ArrowUp" && results.length) { e.preventDefault(); setActive((a) => (a <= 0 ? results.length - 1 : a - 1)); }
    else if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (open && active >= 0 && results[active]) pick(results[active]);
      else if (text.trim().length >= 3) { clearTimeout(timer.current); void search(text, "find"); }
    }
  };
  activeAddress.current = active >= 0 && results[active] ? results[active].address : null;
  const showList = open && results.length > 0;
  // Searching, no matches, busy and errors are a status line under the box (not inside the listbox, and never a popup
  // over the Save button); the popup only ever holds real suggestions.
  const status = !open ? "" : state === "loading" && !results.length ? "Searching" : state === "none" ? "No matches. Check the spelling, or keep the address as typed."
    : state === "busy" ? "Search is busy for a moment. Press Enter to try again." : state === "error" ? message : "";
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">{label}</label>
      <Input id={id} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list" autoComplete="off" autoFocus={autoFocus}
        aria-activedescendant={showList && active >= 0 ? `${id}-o${active}` : undefined} aria-describedby={`${id}-status`}
        value={text} onChange={(e) => type(e.target.value)} onKeyDown={onKey} onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder} maxLength={300} data-testid="address-input" />
      {showList && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-line bg-elevated shadow-pop motion-safe:animate-[fade-in_150ms_ease-out]">
          <ul id={listId} role="listbox" aria-label="Matching addresses" className="max-h-72 overflow-y-auto py-1">
            {results.map((r, i) => (
              <li key={`${r.address}${i}`} id={`${id}-o${i}`} role="option" aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); pick(r); }} onMouseMove={() => { if (active !== i) setActive(i); }}
                className={cn("flex cursor-pointer items-start gap-2 px-3 py-2 text-[13px]", i === active && "bg-hover")}>
                <IconMapPin className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
                <span className="min-w-0"><span className="block truncate font-medium text-fg">{r.label}</span><span className="block truncate text-muted">{r.address}</span></span>
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-3 py-1.5 text-[11.5px] text-subtle">{MAP_ATTRIBUTION}</p>
        </div>
      )}
      <p id={`${id}-status`} role="status" aria-live="polite" data-testid="address-status"
        className={cn("text-[12.5px]", status ? "mt-1.5" : "sr-only", state === "error" ? "text-bad" : "text-muted")}>{status}</p>
    </div>
  );
}

/** Directions links for one place: Apple Maps and Google Maps open the app on a phone. */
export function DirectionsLinks({ place, compact }: { place: Picked; compact?: boolean }) {
  const l = directionsLinks(place);
  return (
    <div className="flex flex-wrap gap-2">
      <a href={l.apple} target="_blank" rel="noopener noreferrer" className={linkCls} data-testid="directions-apple"><IconArrowUpRight className="h-3.5 w-3.5" />{compact ? "Apple Maps" : "Directions in Apple Maps"}</a>
      <a href={l.google} target="_blank" rel="noopener noreferrer" className={linkCls} data-testid="directions-google"><IconArrowUpRight className="h-3.5 w-3.5" />{compact ? "Google Maps" : "Directions in Google Maps"}</a>
    </div>
  );
}

/** The saved address of a contact, company or booking page, with its map and directions; add, change or remove it. */
export function AddressCard({ type, id, title = "Address", hint }: { type: PlaceType; id: string; title?: string; hint?: string }) {
  const qc = useQueryClient();
  const key = ["place", type, id];
  const q = useQuery({ queryKey: key, queryFn: async () => (await api.get<{ place: Place | null }>(`/maps/places?type=${type}&id=${encodeURIComponent(id)}`)).place });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Picked | null>(null);
  const [saving, setSaving] = useState(false);
  const headingId = useId();
  const place = q.data ?? null;

  const save = async () => {
    if (!draft || !draft.address.trim()) return;
    setSaving(true);
    try {
      const r = await api.put<{ place: Place }>("/maps/places", { entityType: type, entityId: id, ...draft });
      qc.setQueryData(key, r.place);
      void qc.invalidateQueries({ queryKey: ["visits"] });
      setEditing(false); setDraft(null);
      toast(r.place.lat === null ? "Address saved without a map pin" : "Address saved");
    } catch (e) { showError(e as Error); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!place) return;
    const before = place;
    try {
      await api.del(`/maps/places?type=${type}&id=${encodeURIComponent(id)}`);
      qc.setQueryData(key, null);
      void qc.invalidateQueries({ queryKey: ["visits"] });
      toast("Address removed", { action: { label: "Undo", onClick: () => { void api.put<{ place: Place }>("/maps/places", { entityType: type, entityId: id, address: before.address, lat: before.lat, lon: before.lon }).then((r) => qc.setQueryData(key, r.place)).catch((err: Error) => showError(err)); } } });
    } catch (e) { showError(e as Error); }
  };

  return (
    <Card className="p-4 text-[13px]" aria-labelledby={headingId} data-testid={`address-card-${type}`}>
      <div className="mb-2 flex items-center gap-2">
        <IconMapPin className="h-4 w-4 text-subtle" />
        <h2 id={headingId} className="text-[12px] font-semibold uppercase tracking-wide text-subtle">{title}</h2>
        {place && !editing && (
          <div className="ml-auto flex gap-1">
            <Button variant="ghost" size="icon" aria-label={`Change ${title.toLowerCase()}`} onClick={() => { setDraft({ address: place.address, lat: place.lat, lon: place.lon }); setEditing(true); }}><IconEdit className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" aria-label={`Remove ${title.toLowerCase()}`} onClick={() => void remove()}><IconTrash className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
      {q.isPending ? <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-28" /></div>
        : q.error ? (
          <div className="space-y-2" role="alert"><p className="text-muted">Could not load the address.</p><Button size="sm" variant="secondary" onClick={() => void q.refetch()}><IconRefresh className="h-4 w-4" />Try again</Button></div>
        ) : editing ? (
          <div className="space-y-2">
            <AddressField label={title} initial={draft?.address ?? ""} onChange={setDraft} autoFocus />
            <p className="text-[12px] text-subtle">{draft?.lat != null ? "Map pin found." : "Pick a match for a map pin, or save the address as typed."}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void save()} disabled={saving || !draft?.address.trim()} data-testid="address-save">{saving ? "Saving" : "Save address"}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(null); }}>Cancel</Button>
            </div>
          </div>
        ) : place ? (
          <div className="space-y-3">
            <p className="break-words text-fg" data-testid="address-text">{place.address}</p>
            {validPoint(place) ? <MapBox points={[{ lat: place.lat as number, lon: place.lon as number, label: place.address }]} className="h-40" label={`Map of ${place.address}`} />
              : <p className="text-[12px] text-subtle">No map pin for this address yet. Change it and pick a match to add one.</p>}
            <DirectionsLinks place={place} compact />
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-muted">{hint ?? "Add an address to see it on a map and get directions."}</p>
            <Button size="sm" variant="secondary" onClick={() => { setDraft(null); setEditing(true); }} data-testid="address-add"><IconPlus className="h-4 w-4" />Add address</Button>
          </div>
        )}
    </Card>
  );
}

interface Candidate { id: string; type: "contact" | "company"; entityId: string; name: string; detail: string; address: string; lat: number | null; lon: number | null }
const STORE = "multies-visits-r115";
interface Saved { ids: string[]; start: Picked | null }
function loadSaved(): Saved {
  try { const v = JSON.parse(localStorage.getItem(STORE) ?? "null") as Saved | null; return v && Array.isArray(v.ids) ? v : { ids: [], start: null }; } catch { return { ids: [], start: null }; }
}
const km = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toString());

/** Contacts > Visits: pick who to visit, put them in the shortest order, open the route in a maps app. */
export function VisitsPlanner() {
  const q = useQuery({ queryKey: ["visits"], queryFn: () => api.get<{ candidates: Candidate[]; limit: number }>("/maps/visits") });
  const [saved, setSaved] = useState<Saved>(loadSaved);
  const [picking, setPicking] = useState(false);
  const [editingStart, setEditingStart] = useState(false);
  const [locating, setLocating] = useState(false);
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch { /* private mode */ } }, [saved]);

  const byId = useMemo(() => new Map((q.data?.candidates ?? []).map((c) => [c.id, c])), [q.data]);
  const stops = saved.ids.map((i) => byId.get(i)).filter((c): c is Candidate => !!c);
  const start = saved.start;
  const startPoint: GeoPoint | null = start && validPoint(start) ? (start as GeoPoint) : null;
  const located = stops.filter((s) => validPoint(s)) as (Candidate & GeoPoint)[];
  const total = pathKm([...(startPoint ? [startPoint] : []), ...located]);
  const best = orderStops(stops, startPoint);
  const bestKm = pathKm([...(startPoint ? [startPoint] : []), ...(best.filter((s) => validPoint(s)) as GeoPoint[])]);
  const canSave = located.length >= 2 && total - bestKm > 0.05;
  const route = routeLinks([...(start ? [start] : []), ...stops]);
  const setIds = (ids: string[]) => setSaved((s) => ({ ...s, ids }));
  const move = (i: number, d: -1 | 1) => { const ids = [...saved.ids.filter((x) => byId.has(x))]; const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; setIds(ids); };
  const reorder = () => { const before = total; setIds(best.map((s) => s.id)); toast(`Shortest order set. About ${km(before - bestKm)} km less in a straight line.`); };
  const here = () => {
    if (!navigator.geolocation) { toast("This browser cannot share your location. Type a start address instead."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setLocating(false); setSaved((s) => ({ ...s, start: { address: "My location", lat: p.coords.latitude, lon: p.coords.longitude } })); setEditingStart(false); },
      () => { setLocating(false); toast("Location was not shared. Type a start address instead."); },
      { timeout: 10_000, maximumAge: 300_000 },
    );
  };
  const copy = async () => {
    const lines = [...(start ? [`Start: ${start.address}`] : []), ...stops.map((s, i) => `${i + 1}. ${s.name}, ${s.address}`)];
    try { await navigator.clipboard.writeText(lines.join("\n")); toast("Visit list copied"); } catch { toast("Could not copy. Select the list and copy it instead."); }
  };

  if (q.isPending) return <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_1fr]"><div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div><Skeleton className="h-80 rounded-xl" /></div>;
  if (q.error) return <EmptyState icon={<IconMapPin />} title="Could not load your visits" body="Check your connection and try again." action={<Button onClick={() => void q.refetch()}><IconRefresh className="h-4 w-4" />Try again</Button>} />;
  const all = q.data.candidates;
  if (!all.length) return <EmptyState icon={<IconMapPin />} title="No addresses yet" body="Open a contact or a company and add their address. Everyone with an address can then go on a visit plan here." action={<Link to="/app/contacts" className={linkCls}>Go to people</Link>} />;

  const mapPoints = [...(startPoint ? [{ ...startPoint, label: "Start" }] : []), ...stops.map((s, i) => ({ s, i })).filter(({ s }) => validPoint(s)).map(({ s, i }) => ({ lat: s.lat as number, lon: s.lon as number, label: s.name, n: i + 1 }))];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_1fr]" data-testid="visits">
      <section aria-label="Visit plan" className="min-w-0 space-y-3">
        <Card className="p-3 text-[13px]">
          <div className="mb-1.5 flex items-center gap-2"><span className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Start</span>
            {start && !editingStart && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditingStart(true)}>Change</Button>}</div>
          {start && !editingStart ? <p className="truncate" data-testid="visit-start">{start.address}</p> : (
            <div className="space-y-2">
              <AddressField label="Start address" initial={start?.address === "My location" ? "" : start?.address ?? ""} placeholder="Where you start the day" onChange={(p) => setSaved((s) => ({ ...s, start: p.address.trim() ? p : null }))} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={here} disabled={locating}><IconMapPin className="h-4 w-4" />{locating ? "Finding you" : "Use my location"}</Button>
                {editingStart && <Button size="sm" variant="ghost" onClick={() => setEditingStart(false)}>Done</Button>}
              </div>
            </div>
          )}
        </Card>

        {stops.length ? (
          <ol className="space-y-2" aria-label="Stops in order" data-testid="visit-stops">
            {stops.map((s, i) => (
              <li key={s.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 motion-safe:transition-colors">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand text-[12px] font-semibold text-brand-fg" aria-hidden>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <Link to={s.type === "contact" ? `/app/contacts/${s.entityId}` : `/app/contacts/companies/${s.entityId}`} className="block truncate text-[13.5px] font-medium hover:underline">{s.name}</Link>
                  <p className="truncate text-[12.5px] text-muted">{shortAddress(s.address)}</p>
                  {!validPoint(s) && <Badge className="mt-1">No map pin, kept last</Badge>}
                </div>
                <div className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><IconArrowUp className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" aria-label={`Move ${s.name} down`} disabled={i === stops.length - 1} onClick={() => move(i, 1)}><IconArrowDown className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" aria-label={`Remove ${s.name}`} onClick={() => setIds(saved.ids.filter((x) => x !== s.id))}><IconClose className="h-4 w-4" /></Button>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState icon={<IconMapPin />} title="Who are you visiting?" body="Add the people and companies on today's round. We put them in the shortest order and open the route in your maps app." />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setPicking(true)} disabled={stops.length >= MAX_VISIT_STOPS} data-testid="visit-add"><IconPlus className="h-4 w-4" />Add stops</Button>
          {stops.length >= 2 && <Button size="sm" variant="secondary" onClick={reorder} disabled={!canSave} aria-describedby={canSave ? undefined : "visit-best-why"} data-testid="visit-best"><IconSparkle className="h-4 w-4" />Shortest order</Button>}
          {stops.length >= 2 && !canSave && <span id="visit-best-why" className="text-[12.5px] text-muted" data-testid="visit-best-why">{bestHint(located.length, !!startPoint)}</span>}
          {stops.length > 0 && <Button size="sm" variant="ghost" onClick={() => void copy()}><IconCopy className="h-4 w-4" />Copy list</Button>}
          {stops.length > 0 && <Button size="sm" variant="ghost" onClick={() => setIds([])}>Clear</Button>}
        </div>
        {stops.length > 0 && (
          <p className="text-[12.5px] text-muted" data-testid="visit-summary">
            {stops.length} {stops.length === 1 ? "stop" : "stops"}{located.length >= 1 && (startPoint || located.length > 1) ? `, about ${km(total)} km in a straight line` : ""}{canSave ? `. The shortest order saves about ${km(total - bestKm)} km.` : "."}
          </p>
        )}
        {route.length > 0 && (
          <div className="space-y-2" data-testid="visit-route">
            {route.map((r, i) => (
              <div key={i} className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                {route.length > 1 && <span className="text-[12px] font-medium text-subtle">Part {i + 1} of {route.length}</span>}
                <a href={r.apple} target="_blank" rel="noopener noreferrer" className={cn(linkCls, "justify-center")} data-testid="route-apple"><IconArrowUpRight className="h-3.5 w-3.5" />Open in Apple Maps</a>
                <a href={r.google} target="_blank" rel="noopener noreferrer" className={cn(linkCls, "justify-center")} data-testid="route-google"><IconArrowUpRight className="h-3.5 w-3.5" />Open in Google Maps</a>
              </div>
            ))}
            {route.length > 1 && <p className="text-[12px] text-subtle">Maps apps take 10 places at a time, so a long day opens in parts.</p>}
          </div>
        )}
      </section>
      <section aria-label="Visit map" className="min-w-0 lg:sticky lg:top-4 lg:self-start">
        {mapPoints.length ? <MapBox points={mapPoints} line className="h-56 lg:h-[520px]" label="Map of the visit plan" />
          : <div className="grid h-56 place-items-center rounded-xl border border-dashed border-line text-[13px] text-muted lg:h-[520px]">Stops with a map pin show here.</div>}
      </section>
      <PickStops open={picking} onClose={() => setPicking(false)} all={all} chosen={saved.ids} max={MAX_VISIT_STOPS}
        onAdd={(ids) => { setIds([...saved.ids, ...ids].slice(0, MAX_VISIT_STOPS)); setPicking(false); }} />
    </div>
  );
}

function PickStops({ open, onClose, all, chosen, onAdd, max }: { open: boolean; onClose: () => void; all: Candidate[]; chosen: string[]; onAdd: (ids: string[]) => void; max: number }) {
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  useEffect(() => { if (open) { setSel([]); setFilter(""); } }, [open]);
  const room = max - chosen.length;
  const f = filter.trim().toLowerCase();
  const list = all.filter((c) => !chosen.includes(c.id) && (!f || `${c.name} ${c.detail} ${c.address}`.toLowerCase().includes(f)));
  return (
    <Dialog open={open} onClose={onClose} title="Add stops" description={`Everyone with a saved address. Up to ${max} stops a day.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => onAdd(sel)} disabled={!sel.length} data-testid="visit-add-confirm">{sel.length ? `Add ${sel.length} ${sel.length === 1 ? "stop" : "stops"}` : "Add stops"}</Button></>}>
      <Input aria-label="Filter people and companies" placeholder="Filter by name or address" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-3" />
      {list.length ? (
        <ul className="max-h-80 space-y-1 overflow-y-auto" aria-label="People and companies with an address">
          {list.map((c) => {
            const on = sel.includes(c.id), full = !on && sel.length >= room;
            return (
              <li key={c.id}>
                <label className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-hover", full && "cursor-not-allowed opacity-60")}>
                  <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand,currentColor)]" checked={on} disabled={full} onChange={() => setSel((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]))} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-medium">{c.name}</span><span className="block truncate text-[12.5px] text-muted">{c.type === "company" ? "Company" : c.detail} · {shortAddress(c.address)}</span></span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : <p className="py-6 text-center text-[13px] text-muted">{all.length > chosen.length ? "No one matches that filter." : "Everyone with an address is already on the plan."}</p>}
    </Dialog>
  );
}
