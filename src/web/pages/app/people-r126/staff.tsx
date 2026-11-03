/**
 * R126 People (flag PEOPLE_R126): Contacts > Staff. Directory with search and team and skill filters, a keyboard
 * navigable org chart, a two week away view built on each person's weekly days off plus their away dates, and the
 * assets register. Members and admins only; the server answers 404 to everyone else and while the flag is off.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { quickRetry } from "@/web/lib/quick-retry-pol1";
import { cn } from "@/web/lib/cn";
import { useConfig } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Input, Select } from "@/web/components/ui/input";
import { Avatar, Badge, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { LoadError } from "@/web/components/load-error-t1g";
import { IconArrowLeft, IconCalendar, IconChevronDown, IconChevronRight, IconDownload, IconLaptop, IconList, IconMapPin, IconPlus, IconSearch, IconUser, IconWarning } from "@/web/components/ui/icon";
import { ASSET_KIND_LABEL, ASSET_STATUSES, ASSET_STATUS_LABEL, addDays, orgTree, warrantySoon, type Asset, type AssetStatus, type StaffPerson } from "@/shared/people-r126";
import { fmtDate, getAssets, getAway, getStaff, pk, todayYmd } from "./model";
import { AssetFormDialog } from "./asset-dialogs";

const VIEWS = [
  { id: "directory", label: "Directory" },
  { id: "org", label: "Org chart" },
  { id: "away", label: "Away" },
  { id: "assets", label: "Assets" },
] as const;
type View = (typeof VIEWS)[number]["id"];

export function PeopleOff() {
  return <EmptyState title="Page not found" body="This page isn't switched on for your workspace." action={<Link to="/app/contacts" className="text-sm font-medium text-brand hover:underline">Back to Contacts</Link>} />;
}

export function StaffPage() {
  const config = useConfig();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((v) => v.id === params.get("view"))?.id ?? "directory") as View;
  const on = !!config.data?.peopleR126;
  const staff = useQuery({ queryKey: pk.staff, queryFn: getStaff, enabled: on, ...quickRetry });
  if (config.data && !on) return <PeopleOff />;
  return (
    <div className="mx-auto w-full max-w-6xl" data-testid="staff-page">
      <Link to="/app/contacts" className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"><IconArrowLeft className="h-4 w-4" aria-hidden="true" />Contacts</Link>
      <PageHeader title="Staff" description="Everyone in your workspace: who they are, who they report to, when they are away and what equipment they hold." />
      <div role="tablist" aria-label="Staff views" className="mb-4 flex w-full overflow-x-auto rounded-lg bg-fill p-0.5 sm:w-fit">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => setParams(v.id === "directory" ? {} : { view: v.id })}
            className={cn("min-h-9 shrink-0 rounded-md px-3 py-1.5 text-[13px] max-sm:min-h-11", view === v.id ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}
            data-testid={`staff-view-${v.id}`}>{v.label}</button>
        ))}
      </div>
      {view === "assets" ? <AssetsView isAdmin={!!staff.data?.isAdmin} /> : staff.isError && !staff.data ? <LoadError onRetry={() => staff.refetch()} /> : !staff.data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading staff">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
      ) : view === "org" ? <OrgChart people={staff.data.people} /> : view === "away" ? <AwayView people={staff.data.people} /> : <Directory people={staff.data.people} me={staff.data.me} />}
    </div>
  );
}

function Directory({ people, me }: { people: StaffPerson[]; me: string }) {
  const [q, setQ] = useState("");
  const [team, setTeam] = useState("");
  const [skill, setSkill] = useState("");
  const teams = useMemo(() => [...new Set(people.map((p) => p.team).filter(Boolean))].sort(), [people]);
  const skills = useMemo(() => [...new Set(people.flatMap((p) => p.skills))].sort((a, b) => a.localeCompare(b)), [people]);
  const byId = useMemo(() => new Map(people.map((p) => [p.userId, p])), [people]);
  const shown = people.filter((p) => {
    const hay = `${p.name} ${p.email} ${p.title} ${p.team} ${p.location} ${p.skills.join(" ")}`.toLowerCase();
    return (!q.trim() || hay.includes(q.trim().toLowerCase())) && (!team || p.team === team) && (!skill || p.skills.includes(skill));
  });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
          <Input aria-label="Search staff" placeholder="Search by name, title or skill" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" data-testid="staff-search" />
        </div>
        <Select aria-label="Filter by team" value={team} onChange={(e) => setTeam(e.target.value)} className="w-full sm:w-44" data-testid="staff-team">
          <option value="">All teams</option>{teams.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        <Select aria-label="Filter by skill" value={skill} onChange={(e) => setSkill(e.target.value)} className="w-full sm:w-44" data-testid="staff-skill">
          <option value="">All skills</option>{skills.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <span className="text-[12.5px] text-subtle" aria-live="polite">{shown.length} {shown.length === 1 ? "person" : "people"}</span>
      </div>
      {!shown.length ? (
        <EmptyState icon={<IconUser className="h-5 w-5" />} title={people.length ? "No one matches" : "No staff yet"}
          body={people.length ? "Try another name, team or skill." : "Invite your team in Settings > Team and they show up here."}
          action={people.length ? <Button size="sm" variant="secondary" onClick={() => { setQ(""); setTeam(""); setSkill(""); }}>Clear filters</Button> : <Link to="/app/settings/team" className="text-sm font-medium text-brand hover:underline">Open Team settings</Link>} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="staff-list">
          {shown.map((p) => (
            <li key={p.userId}>
              <Link to={`/app/contacts/staff/${encodeURIComponent(p.userId)}`} className="flex h-full gap-3 rounded-xl border border-line bg-surface p-4 hover:border-line-strong hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" data-testid="staff-card">
                <Avatar label={p.name} className="h-10 w-10 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5"><span className="truncate font-medium text-fg">{p.name}</span>{p.userId === me && <Badge>You</Badge>}</span>
                  <span className="block truncate text-[13px] text-muted">{[p.title, p.team].filter(Boolean).join(" · ") || "No title yet"}</span>
                  {p.managerUserId && byId.get(p.managerUserId) && <span className="block truncate text-[12.5px] text-subtle">Reports to {byId.get(p.managerUserId)!.name}</span>}
                  {p.location && <span className="mt-0.5 flex items-center gap-1 truncate text-[12.5px] text-subtle"><IconMapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{p.location}</span>}
                  {!!p.skills.length && <span className="mt-2 flex flex-wrap gap-1">{p.skills.slice(0, 4).map((s) => <Badge key={s}>{s}</Badge>)}{p.skills.length > 4 && <Badge>+{p.skills.length - 4}</Badge>}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A simple org tree (WAI-ARIA tree): Up and Down move, Right opens or steps in, Left closes or steps out, Enter opens the profile. */
export function OrgChart({ people }: { people: StaffPerson[] }) {
  const navigate = useNavigate();
  const nodes = useMemo(() => orgTree(people), [people]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(nodes[0]?.person.userId ?? null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const hasKids = (i: number) => nodes[i + 1]?.depth === nodes[i].depth + 1;
  const visible: number[] = [];
  let hideBelow: number | null = null;
  nodes.forEach((n, i) => {
    if (hideBelow !== null && n.depth > hideBelow) return;
    hideBelow = null;
    visible.push(i);
    if (closed.has(n.person.userId) && hasKids(i)) hideBelow = n.depth;
  });
  if (!nodes.length) return <EmptyState title="No one here yet" body="Invite your team in Settings > Team." />;
  const move = (id: string) => { setFocus(id); refs.current.get(id)?.focus(); };
  const onKey = (e: KeyboardEvent, i: number) => {
    const pos = visible.indexOf(i); const n = nodes[i]; const id = n.person.userId;
    if (e.key === "ArrowDown" && pos < visible.length - 1) { e.preventDefault(); move(nodes[visible[pos + 1]].person.userId); }
    else if (e.key === "ArrowUp" && pos > 0) { e.preventDefault(); move(nodes[visible[pos - 1]].person.userId); }
    else if (e.key === "Home") { e.preventDefault(); move(nodes[visible[0]].person.userId); }
    else if (e.key === "End") { e.preventDefault(); move(nodes[visible[visible.length - 1]].person.userId); }
    else if (e.key === "ArrowRight" && hasKids(i)) { e.preventDefault(); if (closed.has(id)) setClosed((s) => { const x = new Set(s); x.delete(id); return x; }); else move(nodes[i + 1].person.userId); }
    else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (hasKids(i) && !closed.has(id)) setClosed((s) => new Set(s).add(id));
      else for (let j = i - 1; j >= 0; j--) if (nodes[j].depth === n.depth - 1) { move(nodes[j].person.userId); break; }
    } else if (e.key === "Enter") { e.preventDefault(); navigate(`/app/contacts/staff/${encodeURIComponent(id)}`); }
  };
  return (
    <div className="rounded-xl border border-line bg-surface p-2 sm:p-3">
      <p id="org-help" className="px-2 pb-2 text-[12.5px] text-subtle">Use arrow keys to move and open branches, Enter to open a profile.</p>
      <ul role="tree" aria-label="Org chart" aria-describedby="org-help" data-testid="org-tree">
        {visible.map((i) => {
          const n = nodes[i]; const id = n.person.userId; const kids = hasKids(i);
          return (
            <li key={id} role="treeitem" aria-level={n.depth + 1} aria-expanded={kids ? !closed.has(id) : undefined} aria-selected={focus === id}
              tabIndex={(focus ?? nodes[0].person.userId) === id ? 0 : -1} ref={(el) => { if (el) refs.current.set(id, el); else refs.current.delete(id); }}
              onKeyDown={(e) => onKey(e, i)} onFocus={() => setFocus(id)}
              className="flex min-h-11 items-center gap-2 rounded-lg pr-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand"
              style={{ paddingLeft: `${Math.min(n.depth, 8) * 20 + 4}px` }} data-testid="org-node">
              {kids ? (
                <button type="button" tabIndex={-1} aria-label={closed.has(id) ? `Open ${n.person.name}'s team` : `Close ${n.person.name}'s team`}
                  onClick={() => setClosed((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; })}
                  className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-fill">
                  {closed.has(id) ? <IconChevronRight className="h-4 w-4" aria-hidden="true" /> : <IconChevronDown className="h-4 w-4" aria-hidden="true" />}
                </button>
              ) : <span className="w-7" aria-hidden="true" />}
              <Avatar label={n.person.name} className="h-7 w-7 shrink-0" />
              <Link to={`/app/contacts/staff/${encodeURIComponent(id)}`} tabIndex={-1} className="min-w-0 flex-1 truncate text-[14px] text-fg hover:underline">{n.person.name}</Link>
              <span className="hidden truncate text-[13px] text-muted sm:block">{[n.person.title, n.person.team].filter(Boolean).join(" · ")}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const mondayOf = (ymd: string) => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return addDays(ymd, d === 0 ? -6 : 1 - d); };
const dayLabel = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" });

/** Who is away, two weeks at a time: weekly days off (the same days off model as project schedules) are shaded, away dates are filled. */
function AwayView({ people }: { people: StaffPerson[] }) {
  const [start, setStart] = useState(() => mondayOf(todayYmd()));
  const days = Array.from({ length: 14 }, (_, i) => addDays(start, i));
  const end = days[13];
  const away = useQuery({ queryKey: pk.away(start, end), queryFn: () => getAway(start, end), ...quickRetry });
  const today = todayYmd();
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setStart(addDays(start, -14))} aria-label="Previous two weeks">Previous</Button>
        <Button size="sm" variant="secondary" onClick={() => setStart(mondayOf(todayYmd()))}>This week</Button>
        <Button size="sm" variant="secondary" onClick={() => setStart(addDays(start, 14))} aria-label="Next two weeks">Next</Button>
        <span className="text-[13px] text-muted" aria-live="polite">{fmtDate(start)} to {fmtDate(end)}</span>
        <span className="ml-auto flex items-center gap-3 text-[12.5px] text-subtle">
          <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm bg-brand/70" aria-hidden="true" />Away</span>
          <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm bg-fill" aria-hidden="true" />Day off</span>
        </span>
      </div>
      {away.isError && !away.data ? <LoadError onRetry={() => away.refetch()} /> : !away.data ? <Skeleton className="h-64 rounded-xl" /> : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[760px] border-collapse text-[13px]" data-testid="away-table">
            <caption className="sr-only">Who is away from {fmtDate(start)} to {fmtDate(end)}</caption>
            <thead><tr>
              <th scope="col" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-medium text-muted">Person</th>
              {days.map((d) => <th key={d} scope="col" aria-current={d === today ? "date" : undefined} className={cn("px-1 py-2 text-center font-medium", d === today ? "text-fg underline decoration-brand decoration-2 underline-offset-4" : "text-muted")}>{dayLabel(d)}</th>)}
            </tr></thead>
            <tbody>
              {people.map((p) => {
                const mine = away.data.away.filter((x) => x.userId === p.userId);
                return (
                  <tr key={p.userId} className="border-t border-line">
                    <th scope="row" className="sticky left-0 z-10 max-w-[180px] truncate bg-surface px-3 py-2 text-left font-normal">
                      <Link to={`/app/contacts/staff/${encodeURIComponent(p.userId)}`} className="text-fg hover:underline">{p.name}</Link>
                    </th>
                    {days.map((d) => {
                      const a = mine.find((x) => x.startDate <= d && x.endDate >= d);
                      const off = p.daysOff.includes(new Date(`${d}T00:00:00Z`).getUTCDay());
                      const label = a ? `Away${a.note ? `: ${a.note}` : ""}` : off ? "Day off" : "Working";
                      return <td key={d} className="px-0.5 py-1.5"><span title={label} aria-label={`${p.name}, ${dayLabel(d)}: ${label}`} role="img"
                        className={cn("mx-auto block h-6 rounded", a ? "bg-brand/70" : off ? "bg-fill" : "bg-transparent")} /></td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!away.data.away.length && <p className="border-t border-line px-3 py-3 text-[13px] text-muted">No one is away in these two weeks. People add time away on their profile.</p>}
        </div>
      )}
    </div>
  );
}

function AssetsView({ isAdmin }: { isAdmin: boolean }) {
  const assets = useQuery({ queryKey: pk.assets, queryFn: getAssets, ...quickRetry });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<AssetStatus | "" | "soon">("");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  if (assets.isError && !assets.data) return <LoadError onRetry={() => assets.refetch()} />;
  if (!assets.data) return <div aria-busy="true" aria-label="Loading assets" className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>;
  const all = assets.data.assets;
  const soon = warrantySoon(all, todayYmd());
  const shown = (status === "soon" ? soon : all.filter((a) => !status || a.status === status)).filter((a) => {
    const hay = `${a.tag} ${a.name} ${a.serial} ${a.assignedName ?? ""} ${ASSET_KIND_LABEL[a.kind]}`.toLowerCase();
    return !q.trim() || hay.includes(q.trim().toLowerCase());
  });
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden="true" />
          <Input aria-label="Search assets" placeholder="Search tag, name, serial or person" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" data-testid="asset-search" />
        </div>
        <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as AssetStatus | "" | "soon")} className="w-full sm:w-48" data-testid="asset-status">
          <option value="">All statuses</option>
          {ASSET_STATUSES.map((s) => <option key={s} value={s}>{ASSET_STATUS_LABEL[s]}</option>)}
          <option value="soon">Warranty ending soon</option>
        </Select>
        {!!soon.length && status !== "soon" && (
          <button type="button" onClick={() => setStatus("soon")} className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-warn-soft px-2.5 text-[13px] text-warn max-sm:min-h-11" data-testid="warranty-soon">
            <IconWarning className="h-4 w-4" aria-hidden="true" />{soon.length} warranty {soon.length === 1 ? "ends" : "end"} soon
          </button>
        )}
        <span className="flex w-full gap-2 sm:ml-auto sm:w-auto">
          {isAdmin && !!all.length && <a href="/api/people/assets.csv" download className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong px-3 text-[13px] hover:bg-hover max-sm:min-h-11"><IconDownload className="h-4 w-4" aria-hidden="true" />Export CSV</a>}
          {!!all.length && <Link to={`/app/contacts/assets/labels?ids=${shown.map((a) => a.id).join(",")}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong px-3 text-[13px] hover:bg-hover max-sm:min-h-11"><IconList className="h-4 w-4" aria-hidden="true" />Print labels</Link>}
          {isAdmin && !!all.length && <Button size="sm" onClick={() => setCreating(true)} data-testid="asset-new"><IconPlus className="h-4 w-4" aria-hidden="true" />New asset</Button>}
        </span>
      </div>
      {!shown.length ? (
        <EmptyState icon={<IconLaptop className="h-5 w-5" />} title={all.length ? "No assets match" : "No assets yet"}
          body={all.length ? "Try another search or status." : isAdmin ? "Add laptops, phones, tools and licences, then hand them to people and print QR labels." : "Your admins have not added any equipment yet."}
          action={!all.length && isAdmin ? <Button size="sm" onClick={() => setCreating(true)} data-testid="asset-new">New asset</Button> : all.length ? <Button size="sm" variant="secondary" onClick={() => { setQ(""); setStatus(""); }}>Clear filters</Button> : undefined} />
      ) : (
        <>
          <table className="hidden w-full border-collapse overflow-hidden rounded-xl border border-line bg-surface text-[13px] md:table" data-testid="asset-table">
            <caption className="sr-only">Assets</caption>
            <thead><tr className="text-left text-muted">{["Tag", "Name", "Type", "Status", "Assigned to", "Warranty end"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {shown.map((a) => <AssetRow key={a.id} a={a} onOpen={() => navigate(`/app/contacts/assets/${encodeURIComponent(a.id)}`)} />)}
            </tbody>
          </table>
          <ul className="space-y-2 md:hidden">
            {shown.map((a) => (
              <li key={a.id}><Link to={`/app/contacts/assets/${encodeURIComponent(a.id)}`} className="block rounded-xl border border-line bg-surface p-3 hover:bg-elevated">
                <span className="flex items-center gap-2"><span className="font-mono text-[12px] text-subtle">{a.tag}</span><span className="min-w-0 flex-1 truncate font-medium text-fg">{a.name}</span><StatusBadge s={a.status} /></span>
                <span className="mt-1 block truncate text-[13px] text-muted">{[ASSET_KIND_LABEL[a.kind], a.assignedName].filter(Boolean).join(" · ")}{a.warrantyEnd ? ` · Warranty ${fmtDate(a.warrantyEnd)}` : ""}</span>
              </Link></li>
            ))}
          </ul>
        </>
      )}
      <AssetFormDialog open={creating} onClose={() => setCreating(false)} onSaved={(a) => navigate(`/app/contacts/assets/${encodeURIComponent(a.id)}`)} />
    </div>
  );
}

function AssetRow({ a, onOpen }: { a: Asset; onOpen: () => void }) {
  const soon = a.warrantyEnd && warrantySoon([a], todayYmd()).length > 0;
  return (
    <tr className="cursor-pointer border-t border-line hover:bg-hover" onClick={onOpen}>
      <td className="px-3 py-2 font-mono text-[12px] text-subtle">{a.tag}</td>
      <td className="px-3 py-2"><Link to={`/app/contacts/assets/${encodeURIComponent(a.id)}`} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>{a.name}</Link></td>
      <td className="px-3 py-2 text-muted">{ASSET_KIND_LABEL[a.kind]}</td>
      <td className="px-3 py-2"><StatusBadge s={a.status} /></td>
      <td className="px-3 py-2 text-muted">{a.assignedName ?? ""}</td>
      <td className={cn("px-3 py-2", soon ? "text-warn" : "text-muted")}>{a.warrantyEnd ? <span className="inline-flex items-center gap-1">{soon && <IconCalendar className="h-3.5 w-3.5" aria-hidden="true" />}{fmtDate(a.warrantyEnd)}</span> : ""}</td>
    </tr>
  );
}

export function StatusBadge({ s }: { s: AssetStatus }) {
  return <Badge tone={s === "in_use" ? "ok" : s === "repair" ? "warn" : s === "lost" ? "bad" : "neutral"}>{ASSET_STATUS_LABEL[s]}</Badge>;
}
