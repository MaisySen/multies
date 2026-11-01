/**
 * R128 Team password vault (/app/tools/vault, Tools feature vault_r128, flag VAULT_R128). Set up, open, folders shared
 * by owners and admins, items encrypted on this device, reveal and copy audited first, secure share by secret link,
 * auto lock. Key model: files/catalogue/r128/DESIGN.md. Nothing secret is ever put in a URL, a query key or an error.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { LoadError } from "@/web/components/load-error-t1g";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Field, Input } from "@/web/components/ui/input";
import { IconFolder, IconFolderPlus, IconHistory, IconKey, IconLock, IconMore, IconPlus, IconSearch, IconShieldCheck, IconUserCog, IconWarning } from "@/web/components/ui/icon";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { useConfig } from "@/web/lib/queries";
import { createAccount, derivePassKeys, openPrivateKey, passphraseProblem } from "@/web/lib/vault-crypto";
import { lockVault, onLock, setVaultOpen, useVaultOpen } from "@/web/lib/vault-session";
import { VAULT_ACCESS_LABEL, VAULT_LOCK_FAILS, type VaultPersonDto, type VaultStateDto } from "@/shared/vault-r128";
import { getState, loadFolders, loadItems, vk, canEdit, type DecFolder, type DecItem } from "./model";
import { AccessDialog, ActivityDialog, FolderDialog, GeneratorDialog, ItemDetailDialog, ItemFormDialog, SettingsDialog, rotateFolder } from "./dialogs";

const ENTRY = "vault";
const DESC = "Shared passwords, encrypted on your device. Only people you share a folder with can open it.";

export function VaultPage() {
  const config = useConfig();
  const qc = useQueryClient();
  const isOpen = useVaultOpen();
  const state = useQuery({ queryKey: vk.state, queryFn: getState, enabled: !!config.data?.vaultR128, retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
  // Locking drops every decrypted thing from memory, not only the keys.
  useEffect(() => onLock(() => { qc.removeQueries({ queryKey: vk.folders }); qc.removeQueries({ queryKey: ["vault", "items"] }); qc.removeQueries({ queryKey: ["vault", "access"] }); }), [qc]);

  if (config.data && !config.data.vaultR128) return <ToolsFrame entryKey={ENTRY} title="Vault" description="Not switched on here." usage={false}><EmptyState title="Page not found" body="The vault is not switched on for this workspace." /></ToolsFrame>;
  const body = state.isPending || config.isPending ? <Card className="space-y-3 p-5"><Skeleton className="h-5 w-48" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></Card>
    : state.isError ? (state.error instanceof ApiError && state.error.status === 404
      ? <EmptyState title="Page not found" body="The vault is not available in this workspace." />
      : <Card data-testid="vault-error"><LoadError onRetry={() => state.refetch()} /></Card>)
    : !state.data!.setUp ? <SetupCard state={state.data!} />
    : !isOpen ? <OpenCard state={state.data!} />
    : <VaultMain state={state.data!} />;
  return (
    <ToolsFrame entryKey={ENTRY} title="Vault" description={DESC} usage={false} testId="vault-page"
      actions={isOpen && state.data?.setUp ? <Button type="button" variant="secondary" size="sm" onClick={() => { lockVault(); toast.success("Vault locked"); }} data-testid="vault-lock"><IconLock className="h-4 w-4" /> Lock</Button> : undefined}>
      {body}
    </ToolsFrame>
  );
}

// ---------------------------------------------------------------- set up and open

function SetupCard({ state }: { state: VaultStateDto }) {
  const qc = useQueryClient();
  const [p1, setP1] = useState(""); const [p2, setP2] = useState(""); const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const problem = passphraseProblem(p1);
    if (problem) { setErr(problem); return; }
    if (p1 !== p2) { setErr("The passphrases don't match."); return; }
    if (!ok) { setErr("Tick the box to confirm you understand."); return; }
    setBusy(true); setErr(null);
    try {
      const acc = await createAccount(p1, state.orgId, state.userId);
      await api.post("/vault/account", { publicKey: acc.publicKey, wrappedPrivateKey: acc.wrappedPrivateKey, salt: acc.salt, iterations: acc.iterations, auth: acc.auth, fingerprint: acc.fingerprint });
      setP1(""); setP2("");
      setVaultOpen(acc.privateKey);
      await qc.invalidateQueries({ queryKey: vk.state });
      toast.success("Your vault is ready");
    } catch (e) { setErr(e instanceof ApiError ? errorMessage(e) : "Couldn't set up the vault on this device. Try again."); } finally { setBusy(false); }
  };
  return (
    <Card className="mx-auto max-w-xl space-y-5 p-5 sm:p-6" data-testid="vault-setup">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-fill"><IconShieldCheck className="h-5 w-5 text-brand-hover" /></span>
        <div><h2 className="text-[17px] font-semibold">Set up your vault</h2><p className="text-[14px] text-muted">Pick a passphrase only you know. It opens your vault on this device and never leaves it.</p></div>
      </div>
      <ul className="space-y-1.5 text-[14px]">
        <li>Passwords are encrypted before they are saved. We only ever store scrambled data.</li>
        <li>Admins share folders with you. You see only folders shared with you.</li>
        <li>The vault locks itself when you are away.</li>
      </ul>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} autoComplete="off">
        <Field label="Vault passphrase" hint="At least 10 characters. A few random words work well.">{(fp) => <Input {...fp} type="password" value={p1} onChange={(e) => setP1(e.target.value)} autoComplete="new-password" autoFocus data-testid="vault-setup-pass" />}</Field>
        <Field label="Passphrase again">{(fp) => <Input {...fp} type="password" value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="new-password" data-testid="vault-setup-pass2" />}</Field>
        <label className="flex items-start gap-2 rounded-lg bg-fill p-3 text-[14px]">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" checked={ok} onChange={(e) => setOk(e.target.checked)} data-testid="vault-setup-ack" />
          <span>I understand that if I forget this passphrase, nobody can recover my vault, not even Multies support.</span>
        </label>
        {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
        <Button type="submit" className="w-full sm:w-auto" disabled={busy} data-testid="vault-setup-go">{busy ? "Setting up, this takes a moment" : "Set up vault"}</Button>
      </form>
    </Card>
  );
}

function OpenCard({ state }: { state: VaultStateDto }) {
  const qc = useQueryClient();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const paused = state.lockedUntil && state.lockedUntil > Date.now();
  const submit = async () => {
    if (!pass) return;
    setBusy(true); setErr(null);
    try {
      const keys = await derivePassKeys(pass, state.kdf!.salt, state.kdf!.iterations);
      const r = await api.post<{ wrappedPrivateKey: string }>("/vault/open", { auth: keys.auth });
      const pk = await openPrivateKey(keys.wrapKey, r.wrappedPrivateKey, state.orgId, state.userId);
      setPass("");
      setVaultOpen(pk);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        const left = Number((e.details as { triesLeft?: number } | undefined)?.triesLeft ?? VAULT_LOCK_FAILS);
        setErr(`Wrong passphrase. ${left} ${left === 1 ? "try" : "tries"} left before opening pauses.`);
      } else if (e instanceof ApiError && e.status === 429) { setErr(errorMessage(e)); void qc.invalidateQueries({ queryKey: vk.state }); }
      else setErr(e instanceof ApiError ? errorMessage(e) : "Couldn't open the vault on this device. Try again.");
    } finally { setBusy(false); }
  };
  return (
    <Card className="mx-auto max-w-md space-y-4 p-5 sm:p-6" data-testid="vault-locked">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-fill"><IconLock className="h-5 w-5 text-brand-hover" /></span>
        <div><h2 className="text-[17px] font-semibold">Vault locked</h2><p className="text-[14px] text-muted">Enter your vault passphrase to open it.</p></div>
      </div>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} autoComplete="off">
        <Field label="Vault passphrase">{(fp) => <Input {...fp} type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" autoFocus disabled={!!paused} data-testid="vault-open-pass" />}</Field>
        {(err || paused) && <p className="text-[13px] text-bad" role="alert" data-testid="vault-open-error">{err ?? `Too many wrong tries. Try again after ${new Date(state.lockedUntil!).toLocaleTimeString(undefined, { timeStyle: "short" })}.`}</p>}
        <Button type="submit" className="w-full" disabled={busy || !pass || !!paused} data-testid="vault-open-go">{busy ? "Opening" : "Open vault"}</Button>
      </form>
      <p className="text-[12px] text-muted">Key fingerprint {state.fingerprint?.match(/.{1,4}/g)?.slice(0, 4).join(" ")}</p>
      <button type="button" className="text-[13px] font-medium text-brand-hover underline" onClick={() => setForgot((f) => !f)} aria-expanded={forgot}>Forgot your passphrase?</button>
      {forgot && <div className="space-y-1 text-[13px] text-muted"><p>Nobody can recover it, not even us. You can reset your vault and pick a new passphrase. You lose access to every folder until an admin shares them with you again.</p><ResetNow /></div>}
    </Card>
  );
}

function ResetNow() {
  const qc = useQueryClient();
  const [arm, setArm] = useState(false);
  return arm
    ? <Button type="button" variant="danger" size="sm" className="mt-2" data-testid="vault-reset-locked" onClick={() => void api.post("/vault/account/reset", { confirm: "reset" }).then(() => { toast.success("Your vault was reset. Pick a new passphrase."); void qc.invalidateQueries({ queryKey: ["vault"] }); }).catch((e) => toast.error(errorMessage(e)))}>Yes, reset my vault</Button>
    : <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setArm(true)}>Reset my vault</Button>;
}

// ---------------------------------------------------------------- open

function VaultMain({ state }: { state: VaultStateDto }) {
  const qc = useQueryClient();
  const folders = useQuery({ queryKey: vk.folders, queryFn: loadFolders, staleTime: 30_000 });
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<null | "gen" | "audit" | "settings" | "newFolder" | "rename" | "access" | "newItem" | "editItem">(null);
  const [detail, setDetail] = useState<DecItem | null>(null);
  const [menu, setMenu] = useState(false);
  const [rotating, setRotating] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const list = useMemo(() => folders.data ?? [], [folders.data]);
  const folder = list.find((f) => f.id === sel) ?? list[0] ?? null;
  useEffect(() => { if (!sel && list[0]) setSel(list[0].id); }, [sel, list]);
  const items = useQuery({ queryKey: vk.items(folder?.id ?? "none"), queryFn: () => loadItems(folder!), enabled: !!folder, staleTime: 30_000 });
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase();
    const all = (items.data ?? []).slice().sort((a, b) => (a.plain?.title ?? "").localeCompare(b.plain?.title ?? "", undefined, { sensitivity: "base" }));
    return words ? all.filter((i) => [i.plain?.title, i.plain?.username, i.plain?.url].some((x) => x?.toLowerCase().includes(words))) : all;
  }, [items.data, q]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) { e.preventDefault(); search.current?.focus(); } };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, []);
  const names = (folderId: string | null, itemId: string | null) => {
    const f = list.find((x) => x.id === folderId);
    let item = "";
    if (folderId && itemId) item = (qc.getQueryData<DecItem[]>(vk.items(folderId)) ?? []).find((i) => i.id === itemId)?.plain?.title ?? "";
    return { folder: f?.name ?? (folderId ? "A folder you can't open" : ""), item };
  };
  const rotate = async () => {
    if (!folder) return;
    setRotating(true);
    try {
      const people = (await api.get<{ people: VaultPersonDto[] }>("/vault/people")).people;
      await rotateFolder(folder, people);
      toast.success("The folder has a new key");
      void qc.invalidateQueries({ queryKey: ["vault"] });
    } catch (e) { toast.error(e instanceof ApiError ? errorMessage(e) : "Couldn't give the folder a new key. Try again."); } finally { setRotating(false); }
  };

  const header = (
    <div className="flex flex-wrap items-center gap-2" data-testid="vault-toolbar">
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen("gen")} data-testid="vault-open-generator"><IconKey className="h-4 w-4" /> Generate</Button>
      {state.isAdmin && <Button type="button" variant="secondary" size="sm" onClick={() => setOpen("audit")} data-testid="vault-open-audit"><IconHistory className="h-4 w-4" /> Activity</Button>}
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen("settings")} data-testid="vault-open-settings">Settings</Button>
    </div>
  );

  if (folders.isPending) return <div className="space-y-3">{header}<Card className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-full" />)}</Card></div>;
  if (folders.isError) return <div className="space-y-3">{header}<Card><LoadError onRetry={() => folders.refetch()} /></Card></div>;

  const dialogs = (
    <>
      <GeneratorDialog open={open === "gen"} onClose={() => setOpen(null)} />
      {state.isAdmin && <ActivityDialog open={open === "audit"} onClose={() => setOpen(null)} names={names} />}
      <SettingsDialog open={open === "settings"} onClose={() => setOpen(null)} state={state} />
      {state.isAdmin && <FolderDialog open={open === "newFolder"} onClose={() => setOpen(null)} folder={null} state={state} onCreated={(id) => setSel(id)} />}
      {folder && <>
        <FolderDialog open={open === "rename"} onClose={() => setOpen(null)} folder={folder} state={state} onCreated={() => undefined} />
        {folder.access === "manage" && <AccessDialog open={open === "access"} onClose={() => setOpen(null)} folder={folder} state={state} />}
        <ItemFormDialog open={open === "newItem" || open === "editItem"} onClose={() => setOpen(null)} folder={folder} item={open === "editItem" ? detail : null} />
        <ItemDetailDialog folder={folder} item={open === "editItem" ? null : detail} shareOn={state.shareOn} onClose={() => setDetail(null)} onEdit={() => setOpen("editItem")} />
      </>}
    </>
  );

  if (!list.length) {
    return (
      <div className="space-y-4">
        {header}
        <Card className="p-2" data-testid="vault-empty">
          <EmptyState icon={<IconFolder className="h-6 w-6" />} title={state.isAdmin ? "No folders yet" : "Nothing shared with you yet"}
            body={state.isAdmin ? "Create a folder, add passwords, then share it with the people who need them." : "When an admin shares a vault folder with you, it shows here."}
            action={state.isAdmin ? <Button type="button" onClick={() => setOpen("newFolder")} data-testid="vault-new-folder"><IconFolderPlus className="h-4 w-4" /> New folder</Button> : undefined} />
        </Card>
        {dialogs}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      <div className="md:grid md:grid-cols-[220px_minmax(0,1fr)] md:gap-4">
        {/* Folders: a list beside the items on wide screens, a scrolling row on phones. */}
        <nav aria-label="Vault folders" className="mb-3 md:mb-0">
          <div className="flex gap-2 overflow-x-auto pb-1 md:flex-col md:gap-0.5 md:overflow-visible" data-testid="vault-folders">
            {list.map((f) => (
              <button key={f.id} type="button" onClick={() => { setSel(f.id); setQ(""); }} aria-current={folder?.id === f.id ? "true" : undefined} data-testid="vault-folder"
                className={`flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-left text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-brand md:w-full ${folder?.id === f.id ? "bg-fill font-semibold text-fg" : "text-muted hover:bg-fill"}`}>
                <IconFolder className="h-4 w-4 shrink-0" />
                <span className="max-w-[160px] truncate md:max-w-none md:flex-1" title={f.name ?? undefined}>{f.name ?? "Can't decrypt"}</span>
                {f.needsRotation && <IconWarning className="h-3.5 w-3.5 shrink-0 text-bad" aria-label="Needs a new key" />}
                <span className="text-[12px] font-normal text-muted">{f.itemCount}</span>
              </button>
            ))}
            {state.isAdmin && <button type="button" onClick={() => setOpen("newFolder")} data-testid="vault-new-folder" className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-[14px] font-medium text-brand-hover outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-brand md:w-full"><IconFolderPlus className="h-4 w-4" /> New folder</button>}
          </div>
        </nav>
        {folder && (
          <section className="min-w-0 space-y-3" aria-label={folder.name ?? "Folder"}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold" title={folder.name ?? undefined}>{folder.name ?? "Can't decrypt this folder"}</h2>
              <Badge>{VAULT_ACCESS_LABEL[folder.access]}</Badge>
              {folder.access === "manage" && <Button type="button" variant="secondary" size="sm" onClick={() => setOpen("access")} data-testid="vault-open-access"><IconUserCog className="h-4 w-4" /> Access</Button>}
              {folder.access === "manage" && (
                <div className="relative">
                  <Button type="button" variant="ghost" size="icon" aria-label="Folder options" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><IconMore className="h-4 w-4" /></Button>
                  {menu && <FolderMenu folder={folder} isAdmin={state.isAdmin} onClose={() => setMenu(false)} onRename={() => { setMenu(false); setOpen("rename"); }} onRotate={() => { setMenu(false); void rotate(); }} onDeleted={() => { setMenu(false); setSel(null); }} />}
                </div>
              )}
            </div>
            {folder.needsRotation && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-fill p-3 text-[14px]" role="status" data-testid="vault-rotate-banner">
                <IconWarning className="h-4 w-4 shrink-0 text-bad" />
                <span className="min-w-0 flex-1">{folder.access === "manage" ? "Someone lost access to this folder. Give it a new key so they can't read later changes." : "Someone lost access to this folder. A folder manager will give it a new key."}</span>
                {folder.access === "manage" && <Button type="button" size="sm" disabled={rotating} onClick={() => void rotate()} data-testid="vault-rotate">{rotating ? "Rotating" : "Rotate key"}</Button>}
              </div>
            )}
            <div className="flex gap-2">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">Search this folder</span>
                <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <Input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this folder" className="pl-9" data-testid="vault-search" />
              </label>
              {canEdit(folder.access) && <Button type="button" onClick={() => setOpen("newItem")} data-testid="vault-new-item"><IconPlus className="h-4 w-4" /><span className="hidden sm:inline"> New item</span><span className="sr-only sm:hidden">New item</span></Button>}
            </div>
            <Card className="overflow-hidden p-0">
              {items.isPending ? <div className="space-y-2 p-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
                : items.isError ? <LoadError compact onRetry={() => items.refetch()} />
                : !items.data!.length ? <EmptyState title="No items yet" body={canEdit(folder.access) ? "Add a login, a card PIN or a server password. It is encrypted before it is saved." : "Nothing in this folder yet."} />
                : !shown.length ? <p className="p-6 text-center text-[14px] text-muted">No items match.</p>
                : (
                  <ul className="divide-y divide-line" data-testid="vault-items">
                    {shown.map((i) => (
                      <li key={i.id}>
                        <button type="button" onClick={() => setDetail(i)} data-testid="vault-item" className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left outline-none hover:bg-fill focus-visible:bg-fill focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand">
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-fill text-[14px] font-semibold uppercase text-muted" aria-hidden>{(i.plain?.title ?? "?").slice(0, 1)}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[15px] font-medium" title={i.plain?.title}>{i.plain?.title ?? "Can't decrypt this item"}</span>
                            <span className="block truncate text-[13px] text-muted">{i.plain?.username || i.plain?.url || " "}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </Card>
          </section>
        )}
      </div>
      {dialogs}
    </div>
  );
}

function FolderMenu({ folder, isAdmin, onClose, onRename, onRotate, onDeleted }: { folder: DecFolder; isAdmin: boolean; onClose: () => void; onRename: () => void; onRotate: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const del = async () => {
    try { await api.del(`/vault/folders/${folder.id}`); toast.success("Folder deleted"); onDeleted(); void qc.invalidateQueries({ queryKey: vk.folders }); } catch (e) { toast.error(errorMessage(e)); }
  };
  const item = "flex min-h-11 w-full items-center px-3 text-left text-[14px] hover:bg-fill focus-visible:bg-fill outline-none";
  return (
    <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg">
      <button type="button" role="menuitem" className={item} onClick={onRename}>Rename</button>
      <button type="button" role="menuitem" className={item} onClick={onRotate}>Give it a new key</button>
      {isAdmin && (confirm
        ? <button type="button" role="menuitem" className={`${item} font-medium text-bad`} onClick={() => void del()} data-testid="vault-folder-delete-confirm">Delete folder and its items</button>
        : <button type="button" role="menuitem" className={`${item} text-bad`} onClick={() => setConfirm(true)}>Delete folder</button>)}
    </div>
  );
}

