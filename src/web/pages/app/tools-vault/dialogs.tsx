/**
 * R128 vault dialogs: item form and detail (reveal and copy are audited first), secure share through secret links,
 * folder access with key rotation on removal, the password generator, the activity log with CSV, and settings.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { LoadError, LoadErrorInline } from "@/web/components/load-error-t1g";
import { LOAD_ERROR_BODY, LOAD_ERROR_TITLE } from "@/web/lib/load-errors-t1g";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { IconCopy, IconEye, IconEyeOff, IconRefresh, IconTrash, IconUserMinus, IconWarning } from "@/web/components/ui/icon";
import { encryptSecret, secretLink } from "@/web/lib/secret-crypto";
import {
  GEN_DEFAULT, derivePassKeys, entropyBits, generatePassword, newFolderKey, openPrivateKey, passphraseProblem, randomId, rewrapPrivateKey,
  sealJson, itemAad, showFingerprint, strengthWord, wrapFolderKey, type GenOptions, type VaultItemPlain,
} from "@/web/lib/vault-crypto";
import { autoLockMinutes, copySecret, lockVault, setAutoLockMinutes } from "@/web/lib/vault-session";
import {
  VAULT_ACCESS_LABEL, VAULT_ACTION_LABEL, VAULT_AUTO_LOCK_CHOICES, VAULT_KDF_ITERATIONS, type VaultAccess, type VaultPersonDto, type VaultStateDto,
} from "@/shared/vault-r128";
import { auditView, blankItem, canEdit, csvCell, currentKey, loadItems, safeUrl, sealFolderName, sealItem, vk, type DecFolder, type DecItem } from "./model";

const mono = "font-mono text-[14px] tracking-wide";

// ---------------------------------------------------------------- generator

export function GeneratorPanel({ onUse }: { onUse?: (pw: string) => void }) {
  const [o, setO] = useState<GenOptions>(GEN_DEFAULT);
  const [pw, setPw] = useState(() => generatePassword(GEN_DEFAULT));
  const regen = (next: GenOptions) => { setO(next); setPw(generatePassword(next)); };
  const bits = entropyBits(o);
  const box = (k: keyof Omit<GenOptions, "length">, label: string) => (
    <label className="flex min-h-11 items-center gap-2 text-[14px]">
      <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={o[k]} onChange={(e) => regen({ ...o, [k]: e.target.checked })} />{label}
    </label>
  );
  return (
    <div className="space-y-4" data-testid="vault-generator">
      <div className="flex items-center gap-2 rounded-lg bg-fill p-3">
        <output className={`min-w-0 flex-1 break-all ${mono}`} data-testid="vault-generated" aria-live="polite">{pw}</output>
        <Button type="button" variant="ghost" size="icon" aria-label="Make another" onClick={() => setPw(generatePassword(o))}><IconRefresh className="h-4 w-4" /></Button>
      </div>
      <p className="text-[13px] text-muted">{strengthWord(bits)}, about {bits} bits</p>
      <label className="block space-y-1 text-[13px] font-medium">
        <span>Length: {o.length}</span>
        <input type="range" min={8} max={128} value={o.length} className="w-full accent-[var(--color-brand)]" aria-label="Length" onChange={(e) => regen({ ...o, length: Number(e.target.value) })} />
      </label>
      <div className="grid grid-cols-2 gap-x-4">
        {box("upper", "Capital letters")}{box("lower", "Small letters")}{box("digits", "Numbers")}{box("symbols", "Symbols")}{box("avoidSimilar", "Avoid look alikes")}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => { void copySecret(pw).then(() => toast.success("Copied. The clipboard clears in 30 seconds.")).catch(() => toast.error("Couldn't copy. Select it and copy instead.")); }}>
          <IconCopy className="h-4 w-4" /> Copy
        </Button>
        {onUse && <Button type="button" onClick={() => onUse(pw)} data-testid="vault-use-generated">Use this password</Button>}
      </div>
    </div>
  );
}

export function GeneratorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onClose={onClose} title="Generate a password" description="Made on this device with a secure random source.">{open && <GeneratorPanel />}</Dialog>;
}

// ---------------------------------------------------------------- item form

export function ItemFormDialog({ folder, item, open, onClose }: { folder: DecFolder; item: DecItem | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState<VaultItemPlain>(blankItem());
  const [show, setShow] = useState(false);
  const [gen, setGen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setV(item?.plain ? { ...item.plain } : blankItem()); setShow(false); setGen(false); setErr(null); } }, [open, item]);
  const save = useMutation({
    mutationFn: async () => {
      if (!v.title.trim()) throw new Error("Give it a name.");
      const plain = { ...v, title: v.title.trim().slice(0, 200), username: v.username.slice(0, 500), password: v.password.slice(0, 2000), url: v.url.trim().slice(0, 2000), notes: v.notes.slice(0, 10_000) };
      const id = item?.id ?? randomId("vi");
      const ct = await sealItem(folder, id, plain);
      if (item) await api.put(`/vault/folders/${folder.id}/items/${id}`, { ct, keyVersion: folder.keyVersion });
      else await api.post(`/vault/folders/${folder.id}/items`, { id, ct, keyVersion: folder.keyVersion });
    },
    onSuccess: () => { toast.success(item ? "Saved" : "Added"); void qc.invalidateQueries({ queryKey: vk.items(folder.id) }); void qc.invalidateQueries({ queryKey: vk.folders }); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? errorMessage(e) : e instanceof Error && e.message === "Give it a name." ? e.message : "Couldn't save. Try again."),
  });
  const set = (k: keyof VaultItemPlain) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Dialog open={open} onClose={onClose} title={item ? "Edit item" : "New item"} description={`In ${folder.name ?? "this folder"}. Encrypted on this device before it is saved.`}
      footer={<><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="vault-item-form" disabled={save.isPending} data-testid="vault-item-save">{save.isPending ? "Saving" : "Save"}</Button></>}>
      <form id="vault-item-form" className="space-y-4" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }} autoComplete="off">
        <Field label="Name">{(fp) => <Input {...fp} value={v.title} onChange={set("title")} maxLength={200} required autoFocus data-testid="vault-item-title" />}</Field>
        <Field label="Username or email">{(fp) => <Input {...fp} value={v.username} onChange={set("username")} autoComplete="off" data-testid="vault-item-username" />}</Field>
        <Field label="Password">{(fp) => (
          <div className="flex gap-2">
            <Input {...fp} type={show ? "text" : "password"} value={v.password} onChange={set("password")} autoComplete="new-password" className={`min-w-0 flex-1 ${mono}`} data-testid="vault-item-password" />
            <Button type="button" variant="ghost" size="icon" aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow((s) => !s)}>{show ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}</Button>
          </div>
        )}</Field>
        <Button type="button" variant="secondary" size="sm" onClick={() => setGen((g) => !g)} aria-expanded={gen} data-testid="vault-item-generate">{gen ? "Hide generator" : "Generate a password"}</Button>
        {gen && <div className="rounded-xl border border-line p-3"><GeneratorPanel onUse={(pw) => { setV((x) => ({ ...x, password: pw })); setGen(false); setShow(true); }} /></div>}
        <Field label="Website">{(fp) => <Input {...fp} value={v.url} onChange={set("url")} inputMode="url" placeholder="example.com" data-testid="vault-item-url" />}</Field>
        <Field label="Notes">{(fp) => <Textarea {...fp} value={v.notes} onChange={set("notes")} rows={3} />}</Field>
        {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- item detail

function SecretRow({ label, value, field, folder, item, secret }: { label: string; value: string; field: string; folder: DecFolder; item: DecItem; secret: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [busy, setBusy] = useState(false);
  if (!value) return null;
  const reveal = async () => {
    if (shown) { setShown(false); return; }
    setBusy(true);
    try { await auditView(folder.id, item.id, "reveal", field); setShown(true); } catch { toast.error("Couldn't record the view, so it stays hidden. Try again."); } finally { setBusy(false); }
  };
  const copy = async () => {
    setBusy(true);
    try { await auditView(folder.id, item.id, "copy", field); } catch { toast.error("Couldn't record the copy, so nothing was copied. Try again."); setBusy(false); return; }
    try { await copySecret(value); toast.success(`${label} copied. The clipboard clears in 30 seconds.`); } catch { toast.error("Couldn't copy here. Reveal it and copy by hand."); } finally { setBusy(false); }
  };
  const href = field === "url" ? safeUrl(value) : null;
  return (
    <div className="border-b border-line py-2.5 last:border-0" data-testid={`vault-row-${field}`}>
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className="flex min-h-11 items-center gap-1">
        <div className={`min-w-0 flex-1 break-all ${secret ? mono : "text-[15px]"}`} data-testid={`vault-value-${field}`}>
          {shown ? (href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-hover underline">{value}</a> : <span className="whitespace-pre-wrap">{value}</span>) : "••••••••••••"}
        </div>
        {secret && <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={shown ? `Hide ${label.toLowerCase()}` : `Reveal ${label.toLowerCase()}`} onClick={() => void reveal()} data-testid={`vault-reveal-${field}`}>{shown ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}</Button>}
        <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy()} data-testid={`vault-copy-${field}`}><IconCopy className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

export function ItemDetailDialog({ folder, item, shareOn, onClose, onEdit }: { folder: DecFolder; item: DecItem | null; shareOn: boolean; onClose: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [share, setShare] = useState(false);
  const del = useMutation({
    mutationFn: () => api.del(`/vault/folders/${folder.id}/items/${item!.id}`),
    onSuccess: () => { setConfirm(false); toast.success("Item deleted"); void qc.invalidateQueries({ queryKey: vk.items(folder.id) }); void qc.invalidateQueries({ queryKey: vk.folders }); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const p = item?.plain;
  return (
    <>
      <Dialog open={!!item} onClose={onClose} title={p?.title || "Item"} description={folder.name ?? undefined}
        footer={item && <div className="flex w-full flex-wrap items-center gap-2">
          {canEdit(folder.access) && <Button type="button" variant="ghost" onClick={() => setConfirm(true)} aria-label="Delete item"><IconTrash className="h-4 w-4" /></Button>}
          <span className="flex-1" />
          {shareOn && p?.password && <Button type="button" variant="secondary" onClick={() => setShare(true)} data-testid="vault-share">Share securely</Button>}
          {canEdit(folder.access) && <Button type="button" onClick={onEdit} data-testid="vault-edit">Edit</Button>}
        </div>}>
        {item && p ? (
          <div data-testid="vault-detail">
            <SecretRow label="Username" value={p.username} field="username" folder={folder} item={item} secret={false} />
            <SecretRow label="Password" value={p.password} field="password" folder={folder} item={item} secret />
            <SecretRow label="Website" value={p.url} field="url" folder={folder} item={item} secret={false} />
            <SecretRow label="Notes" value={p.notes} field="notes" folder={folder} item={item} secret />
            {!p.username && !p.password && !p.url && !p.notes && <p className="py-4 text-[14px] text-muted">Nothing saved in this item yet.</p>}
          </div>
        ) : <p className="py-4 text-[14px] text-bad">Couldn't decrypt this item. Ask a folder manager to give the folder a new key.</p>}
      </Dialog>
      {item && p && <ShareDialog open={share} onClose={() => setShare(false)} folder={folder} item={item} plain={p} />}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => del.mutate()} busy={del.isPending} title="Delete this item?" description="It is deleted for everyone with access to this folder." />
    </>
  );
}

// ---------------------------------------------------------------- secure share (R88 secret links)

const SHARE_EXPIRY = [{ s: 3600, l: "1 hour" }, { s: 86_400, l: "1 day" }, { s: 7 * 86_400, l: "7 days" }];
export function ShareDialog({ open, onClose, folder, item, plain }: { open: boolean; onClose: () => void; folder: DecFolder; item: DecItem; plain: VaultItemPlain }) {
  const [what, setWhat] = useState<"password" | "login" | "all">("password");
  const [views, setViews] = useState("1");
  const [expiry, setExpiry] = useState("3600");
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => { if (open) setLink(null); }, [open]);
  const make = useMutation({
    mutationFn: async () => {
      await auditView(folder.id, item.id, "share", what === "password" ? "password" : "custom");
      const lines = what === "password" ? [plain.password]
        : [plain.username && `Username: ${plain.username}`, `Password: ${plain.password}`, what === "all" && plain.url && `Website: ${plain.url}`, what === "all" && plain.notes && `Notes: ${plain.notes}`].filter(Boolean) as string[];
      const { ciphertext, key } = await encryptSecret({ kind: "text", text: lines.join("\n") });
      // No label: the item name stays encrypted too.
      const r = await api.post<{ secret: { url: string } }>("/tools/secrets", { kind: "text", ciphertext, label: null, passphrase: false, maxViews: Number(views), expiresInSeconds: Number(expiry), notify: true });
      return secretLink(r.secret.url, key);
    },
    onSuccess: (l) => setLink(l),
    onError: (e) => toast.error(e instanceof ApiError ? errorMessage(e) : "Couldn't make the link. Try again."),
  });
  return (
    <Dialog open={open} onClose={onClose} title="Share securely" description="A link that opens once, encrypted on this device. The key is in the link after #, so we never see it.">
      {link ? (
        <div className="space-y-3" data-testid="vault-share-done">
          <p className="break-all rounded-lg bg-fill p-3 font-mono text-[13px]" data-testid="vault-share-link">{link}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Done</Button>
            <Button type="button" onClick={() => void copySecret(link).then(() => toast.success("Link copied")).catch(() => toast.error("Couldn't copy. Select the link instead."))}><IconCopy className="h-4 w-4" /> Copy link</Button>
          </div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); make.mutate(); }}>
          <Field label="What to share">{(fp) => <Select {...fp} value={what} onChange={(e) => setWhat(e.target.value as typeof what)} data-testid="vault-share-what">
              <option value="password">Password only</option><option value="login">Username and password</option><option value="all">Everything in this item</option>
            </Select>}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Can be opened">{(fp) => <Select {...fp} value={views} onChange={(e) => setViews(e.target.value)}>{[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n === 1 ? "Once" : `${n} times`}</option>)}</Select>}</Field>
            <Field label="Expires after">{(fp) => <Select {...fp} value={expiry} onChange={(e) => setExpiry(e.target.value)}>{SHARE_EXPIRY.map((x) => <option key={x.s} value={x.s}>{x.l}</option>)}</Select>}</Field>
          </div>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={make.isPending} data-testid="vault-share-make">{make.isPending ? "Making the link" : "Make link"}</Button></div>
        </form>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- folders, access and rotation

/** New folder key for exactly the people who still have access; every item and the name encrypted again here. */
export async function rotateFolder(folder: DecFolder, people: VaultPersonDto[]): Promise<number> {
  const access = await api.get<{ members: { userId: string }[]; keyVersion: number }>(`/vault/folders/${folder.id}/access`);
  const items = await loadItems(folder);
  if (items.some((i) => !i.plain)) throw new Error("undecryptable");
  const nk = await newFolderKey();
  const keys = await Promise.all(access.members.map(async (m) => {
    const pk = people.find((p) => p.userId === m.userId)?.publicKey;
    if (!pk) throw new Error("missing key");
    return { userId: m.userId, wrappedKey: await wrapFolderKey(nk, pk) };
  }));
  const attempt = async (toVersion: number) => api.post<{ keyVersion: number }>(`/vault/folders/${folder.id}/rotate`, {
    fromVersion: folder.keyVersion, toVersion, keys, nameCt: await sealFolderName(nk, folder.id, toVersion, folder.name ?? "Folder"),
    items: await Promise.all(items.map(async (i) => ({ id: i.id, ct: await sealJson(nk, i.plain, itemAad(folder.id, i.id, toVersion)) }))),
  });
  const first = Math.max(folder.keyVersion, ...folder.keys.map((k) => k.version)) + 1;
  try { return (await attempt(first)).keyVersion; } catch (e) {
    const to = e instanceof ApiError ? Number((e.details as { toVersion?: number } | undefined)?.toVersion) : NaN;
    if (Number.isFinite(to) && to !== first) return (await attempt(to)).keyVersion;
    throw e;
  }
}

export function FolderDialog({ open, onClose, folder, state, onCreated }: { open: boolean; onClose: () => void; folder: DecFolder | null; state: VaultStateDto; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(folder?.name ?? ""); setErr(null); } }, [open, folder]);
  const people = useQuery({ queryKey: vk.people, queryFn: () => api.get<{ people: VaultPersonDto[] }>("/vault/people"), enabled: open && !folder });
  useEffect(() => { if (open && !folder) void people.refetch(); }, [open, folder]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: async () => {
      const n = name.trim().slice(0, 120);
      if (!n) throw new Error("name");
      if (folder) {
        await api.patch(`/vault/folders/${folder.id}`, { nameCt: await sealFolderName(await currentKey(folder), folder.id, folder.keyVersion, n), keyVersion: folder.keyVersion });
        return folder.id;
      }
      const id = randomId("vf");
      const key = await newFolderKey();
      const admins = (people.data?.people ?? []).filter((p) => p.publicKey && (p.role === "owner" || p.role === "admin"));
      if (!admins.some((p) => p.userId === state.userId)) throw new Error("people");
      const keys = await Promise.all(admins.map(async (p) => ({ userId: p.userId, wrappedKey: await wrapFolderKey(key, p.publicKey!), access: "manage" as VaultAccess })));
      await api.post("/vault/folders", { id, nameCt: await sealFolderName(key, id, 1, n), keys });
      return id;
    },
    onSuccess: (id) => { toast.success(folder ? "Folder renamed" : "Folder created"); void qc.invalidateQueries({ queryKey: vk.folders }); onClose(); if (!folder) onCreated(id); },
    onError: (e) => setErr(e instanceof Error && e.message === "name" ? "Give the folder a name." : e instanceof Error && e.message === "people" ? `${LOAD_ERROR_TITLE}. ${LOAD_ERROR_BODY}` : e instanceof ApiError ? errorMessage(e) : "Couldn't save. Try again."),
  });
  return (
    <Dialog open={open} onClose={onClose} title={folder ? "Rename folder" : "New folder"} description={folder ? undefined : "Owners and admins who have set up their vault can manage it too. Share it with others after."}
      footer={<><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="vault-folder-form" disabled={save.isPending || (!folder && people.isPending)} data-testid="vault-folder-save">{save.isPending ? "Saving" : folder ? "Save" : "Create folder"}</Button></>}>
      <form id="vault-folder-form" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <Field label="Folder name">{(fp) => <Input {...fp} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus data-testid="vault-folder-name" />}</Field>
        {err && <p className="mt-2 text-[13px] text-bad" role="alert">{err}</p>}
      </form>
    </Dialog>
  );
}

export function AccessDialog({ open, onClose, folder, state }: { open: boolean; onClose: () => void; folder: DecFolder; state: VaultStateDto }) {
  const qc = useQueryClient();
  const access = useQuery({ queryKey: vk.access(folder.id), queryFn: () => api.get<{ members: { userId: string; name: string; email: string; role: string; access: VaultAccess; fingerprint: string | null }[]; needsRotation: boolean }>(`/vault/folders/${folder.id}/access`), enabled: open });
  const people = useQuery({ queryKey: vk.people, queryFn: () => api.get<{ people: VaultPersonDto[] }>("/vault/people"), enabled: open });
  // Fresh each time it opens: someone may have joined or set up their vault since.
  useEffect(() => { if (open) { void people.refetch(); void access.refetch(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pick, setPick] = useState("");
  const [level, setLevel] = useState<VaultAccess>("view");
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  const inFolder = new Set((access.data?.members ?? []).map((m) => m.userId));
  const candidates = (people.data?.people ?? []).filter((p) => !inFolder.has(p.userId));
  const chosen = candidates.find((p) => p.userId === pick);
  const isAdminRole = (r?: string) => r === "owner" || r === "admin";
  const refresh = () => { void qc.invalidateQueries({ queryKey: vk.access(folder.id) }); void qc.invalidateQueries({ queryKey: vk.folders }); };
  const add = useMutation({
    mutationFn: async () => {
      if (!chosen?.publicKey) throw new Error("pick");
      await api.post(`/vault/folders/${folder.id}/access`, { userId: chosen.userId, wrappedKey: await wrapFolderKey(await currentKey(folder), chosen.publicKey), access: level, keyVersion: folder.keyVersion });
    },
    onSuccess: () => { toast.success(`${chosen?.name ?? "They"} can now open this folder`); setPick(""); setLevel("view"); refresh(); },
    onError: (e) => toast.error(e instanceof ApiError ? errorMessage(e) : "Choose someone who has set up their vault."),
  });
  const change = useMutation({ mutationFn: (x: { userId: string; access: VaultAccess }) => api.patch(`/vault/folders/${folder.id}/access/${x.userId}`, { access: x.access }), onSuccess: () => { toast.success("Access changed"); refresh(); }, onError: (e) => toast.error(errorMessage(e)) });
  const remove = useMutation({
    mutationFn: async (userId: string) => {
      await api.del(`/vault/folders/${folder.id}/access/${userId}`);
      try { await rotateFolder({ ...folder, needsRotation: true }, people.data?.people ?? []); return true; } catch { return false; }
    },
    onSuccess: (rotated) => {
      setRemoving(null);
      if (rotated) toast.success("Access removed and the folder has a new key. Change any passwords they could see.");
      else toast.error("Access removed, but the new key isn't in place yet. Use Rotate key on the folder.");
      void qc.invalidateQueries({ queryKey: ["vault"] });
    },
    onError: (e) => { setRemoving(null); toast.error(errorMessage(e)); },
  });
  return (
    <>
      <Dialog open={open && !removing} onClose={onClose} title="Who has access" description={`${folder.name ?? "This folder"}. Compare a key fingerprint with the person if you want to be sure it is theirs.`}>
        <div className="space-y-4" data-testid="vault-access">
          {access.isPending ? <p className="py-4 text-[14px] text-muted">Loading</p>
            : access.isError ? <LoadErrorInline className="py-4" onRetry={() => access.refetch()} />
            : (
              <ul className="divide-y divide-line">
                {access.data!.members.map((m) => (
                  <li key={m.userId} className="flex flex-wrap items-center gap-2 py-2.5" data-testid="vault-access-row">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium" title={m.email}>{m.name}{m.userId === state.userId && <span className="text-muted"> (you)</span>}</div>
                      {m.fingerprint && <div className="truncate font-mono text-[11px] text-muted" title="Key fingerprint">{showFingerprint(m.fingerprint)}</div>}
                    </div>
                    <Select aria-label={`Access for ${m.name}`} value={m.access} disabled={m.userId === state.userId || change.isPending} className="w-36" onChange={(e) => change.mutate({ userId: m.userId, access: e.target.value as VaultAccess })}>
                      <option value="view">{VAULT_ACCESS_LABEL.view}</option><option value="edit">{VAULT_ACCESS_LABEL.edit}</option>{isAdminRole(m.role) && <option value="manage">{VAULT_ACCESS_LABEL.manage}</option>}
                    </Select>
                    {m.userId !== state.userId && <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${m.name}`} onClick={() => setRemoving({ userId: m.userId, name: m.name })} data-testid="vault-access-remove"><IconUserMinus className="h-4 w-4" /></Button>}
                  </li>
                ))}
              </ul>
            )}
          {folder.needsRotation || access.data?.needsRotation
            ? <p className="text-[13px] text-muted">Give the folder a new key before adding people.</p>
            : (
              <form className="flex flex-wrap items-end gap-2 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
                <Field label="Add a person" className="min-w-0 flex-1">{(fp) => <Select {...fp} value={pick} onChange={(e) => { setPick(e.target.value); setLevel("view"); }} data-testid="vault-access-pick">
                    <option value="">Choose someone</option>
                    {candidates.map((p) => <option key={p.userId} value={p.userId} disabled={!p.publicKey}>{p.name}{p.publicKey ? "" : " (vault not set up yet)"}</option>)}
                  </Select>}
                </Field>
                <Field label="Access" className="w-36">{(fp) => <Select {...fp} value={level} onChange={(e) => setLevel(e.target.value as VaultAccess)} data-testid="vault-access-level">
                    <option value="view">{VAULT_ACCESS_LABEL.view}</option><option value="edit">{VAULT_ACCESS_LABEL.edit}</option>{isAdminRole(chosen?.role) && <option value="manage">{VAULT_ACCESS_LABEL.manage}</option>}
                  </Select>}
                </Field>
                <Button type="submit" disabled={!chosen?.publicKey || add.isPending} data-testid="vault-access-add">{add.isPending ? "Adding" : "Add"}</Button>
                {candidates.some((p) => !p.publicKey) && <p className="w-full text-[12px] text-muted">People see the vault after they open it once and pick their own passphrase.</p>}
              </form>
            )}
        </div>
      </Dialog>
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing.userId)} busy={remove.isPending} confirmLabel="Remove"
        title={`Remove ${removing?.name ?? "this person"}?`} description="They lose access now and the folder gets a new key on this device. They may have copied passwords already, so change the ones that matter." />
    </>
  );
}

// ---------------------------------------------------------------- activity

interface AuditRow { id: string; userId: string; userName: string; folderId: string | null; itemId: string | null; action: string; field: string | null; at: number }
export function ActivityDialog({ open, onClose, names }: { open: boolean; onClose: () => void; names: (folderId: string | null, itemId: string | null) => { folder: string; item: string } }) {
  const q = useQuery({ queryKey: vk.audit, queryFn: () => api.get<{ rows: AuditRow[]; next: number | null }>("/vault/audit"), enabled: open });
  const fmt = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const csv = () => {
    const head = ["When", "Person", "Action", "Field", "Folder", "Item"];
    const rows = (q.data?.rows ?? []).map((r) => { const n = names(r.folderId, r.itemId); return [new Date(r.at).toISOString(), r.userName, VAULT_ACTION_LABEL[r.action] ?? r.action, r.field ?? "", n.folder, n.item]; });
    const blob = new Blob([[head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "vault-activity.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Vault activity" description="Every reveal, copy and share, and every change. Values are never recorded." className="sm:max-w-3xl"
      footer={<><Button type="button" variant="ghost" onClick={onClose}>Close</Button><Button type="button" variant="secondary" disabled={!q.data?.rows.length} onClick={csv} data-testid="vault-audit-csv">Download CSV</Button></>}>
      {q.isPending ? <p className="py-6 text-center text-[14px] text-muted">Loading</p>
        : q.isError ? <LoadError compact onRetry={() => q.refetch()} />
        : !q.data!.rows.length ? <p className="py-6 text-center text-[14px] text-muted">No activity yet.</p>
        : (
          <ul className="divide-y divide-line" data-testid="vault-audit">
            {q.data!.rows.map((r) => { const n = names(r.folderId, r.itemId); return (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 py-2 text-[14px]" data-testid="vault-audit-row">
                <span className="font-medium">{r.userName || "Someone"}</span>
                <span>{(VAULT_ACTION_LABEL[r.action] ?? r.action).toLowerCase()}{r.field ? ` ${r.field}` : ""}</span>
                {(n.item || n.folder) && <span className="min-w-0 truncate text-muted">{[n.item, n.folder].filter(Boolean).join(" in ")}</span>}
                <span className="ml-auto text-[12px] text-muted">{fmt(r.at)}</span>
              </li>
            ); })}
          </ul>
        )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- settings

export function SettingsDialog({ open, onClose, state }: { open: boolean; onClose: () => void; state: VaultStateDto }) {
  const qc = useQueryClient();
  const [mins, setMins] = useState(autoLockMinutes());
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [again, setAgain] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [reset, setReset] = useState(false);
  const [typed, setTyped] = useState("");
  useEffect(() => { if (open) { setMins(autoLockMinutes()); setCur(""); setNext(""); setAgain(""); setErr(null); setReset(false); setTyped(""); } }, [open]);
  const change = useMutation({
    mutationFn: async () => {
      const problem = passphraseProblem(next);
      if (problem) throw new Error(problem);
      if (next !== again) throw new Error("The new passphrases don't match.");
      const old = await derivePassKeys(cur, state.kdf!.salt, state.kdf!.iterations);
      const { wrappedPrivateKey } = await api.post<{ wrappedPrivateKey: string }>("/vault/open", { auth: old.auth });
      const salt = (await createSalt());
      const fresh = await derivePassKeys(next, salt, VAULT_KDF_ITERATIONS);
      const re = await rewrapPrivateKey(old.wrapKey, fresh.wrapKey, wrappedPrivateKey, state.orgId, state.userId);
      await openPrivateKey(fresh.wrapKey, re, state.orgId, state.userId);
      await api.post("/vault/account/passphrase", { auth: old.auth, newAuth: fresh.auth, salt, iterations: VAULT_KDF_ITERATIONS, wrappedPrivateKey: re });
    },
    onSuccess: () => { toast.success("Passphrase changed"); setCur(""); setNext(""); setAgain(""); void qc.invalidateQueries({ queryKey: vk.state }); },
    onError: (e) => setErr(e instanceof ApiError ? errorMessage(e) : e instanceof Error && !/operation|decrypt/i.test(e.message) ? e.message : "Couldn't change it. Check your current passphrase."),
  });
  const doReset = useMutation({
    mutationFn: () => api.post("/vault/account/reset", { confirm: "reset" }),
    onSuccess: () => { lockVault(); toast.success("Your vault was reset. Set a new passphrase, then ask an admin to share folders again."); void qc.invalidateQueries({ queryKey: ["vault"] }); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onClose={onClose} title="Vault settings">
      <div className="space-y-6">
        <Field label="Lock after no activity for">{(fp) => <Select {...fp} value={mins} onChange={(e) => { const m = Number(e.target.value); setMins(m); setAutoLockMinutes(m); }} data-testid="vault-autolock">
            {VAULT_AUTO_LOCK_CHOICES.map((m) => <option key={m} value={m}>{m === 60 ? "1 hour" : `${m} minutes`}</option>)}
          </Select>}
        </Field>
        <form className="space-y-3 border-t border-line pt-5" onSubmit={(e) => { e.preventDefault(); setErr(null); change.mutate(); }} autoComplete="off">
          <h3 className="text-[15px] font-semibold">Change passphrase</h3>
          <Field label="Current passphrase">{(fp) => <Input {...fp} type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />}</Field>
          <Field label="New passphrase" hint="At least 10 characters. A few random words work well.">{(fp) => <Input {...fp} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />}</Field>
          <Field label="New passphrase again">{(fp) => <Input {...fp} type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />}</Field>
          {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
          <div className="flex justify-end"><Button type="submit" variant="secondary" disabled={change.isPending || !cur || !next}>{change.isPending ? "Changing" : "Change passphrase"}</Button></div>
        </form>
        <div className="space-y-3 border-t border-line pt-5">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold"><IconWarning className="h-4 w-4 text-bad" /> Forgot your passphrase?</h3>
          <p className="text-[13px] text-muted">Nobody can recover it, not even us. Resetting removes your vault key and your access to every folder. An admin can share folders with you again after you set a new passphrase.</p>
          {reset ? (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim().toLowerCase() === "reset") doReset.mutate(); }}>
              <Field label="Type reset to confirm" className="min-w-0 flex-1">{(fp) => <Input {...fp} value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="vault-reset-type" />}</Field>
              <Button type="submit" variant="danger" disabled={typed.trim().toLowerCase() !== "reset" || doReset.isPending} data-testid="vault-reset-confirm">Reset my vault</Button>
            </form>
          ) : <Button type="button" variant="outline" onClick={() => setReset(true)} data-testid="vault-reset">Reset my vault</Button>}
        </div>
      </div>
    </Dialog>
  );
}

async function createSalt(): Promise<string> {
  const { toB64u } = await import("@/web/lib/secret-crypto");
  return toB64u(crypto.getRandomValues(new Uint8Array(16)));
}

