/**
 * DES1: Passkeys in Account and security (PASSKEY_DES1). Add one with Face ID, a fingerprint, the device PIN or a
 * security key; see when each was added and last used; rename; remove (needs a sign in from the last 15 minutes).
 * Forgetting a device is safe: the normal sign in always works, and there is no other way around it.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { IconKey } from "@/web/components/ui/icon";
import { Skeleton } from "@/web/components/ui/misc";
import { requireText, useDialogs } from "@/web/components/ui/confirm";
import { LoadErrorInline } from "@/web/components/load-error-t1g";
import { timeAgo } from "@/web/lib/format";
import { addPasskey, passkeyMessage, passkeysSupported, wasCancelled } from "@/web/lib/passkeys-des1";
import { Section } from "./settings";

interface Passkey { id: string; name: string; createdAt: string; lastUsedAt: string | null; device: string }
const KEY = ["passkeys-des1"] as const;

export function PasskeysSection() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: async () => (await api.get<{ passkeys: Passkey[] }>("/passkeys")).passkeys });
  const [adding, setAdding] = useState(false);
  const { confirm, prompt, dialogs } = useDialogs();
  const supported = passkeysSupported();
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  const add = async () => {
    setAdding(true);
    try {
      await addPasskey();
      toast.success("Passkey added. Next time, sign in with Face ID, your fingerprint or your device PIN.");
      await refresh();
    } catch (err) {
      if (!wasCancelled(err)) toast.error(passkeyMessage(err, "That passkey could not be added. Try again."));
    } finally { setAdding(false); }
  };
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch(`/passkeys/${id}`, { name }),
    onSuccess: () => { toast.success("Passkey renamed"); void refresh(); },
    onError: (e) => toast.error(passkeyMessage(e, "Could not rename it. Try again.")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/passkeys/${id}`),
    onSuccess: () => { toast.success("Passkey removed"); void refresh(); },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "reauth_required" ? "For your safety, sign out and sign in again, then remove it." : passkeyMessage(e, "Could not remove it. Try again.")),
  });

  return (
    <Section id="passkeys" title="Passkeys" description="Sign in with Face ID, your fingerprint, your device PIN or a security key. No password to type, and nothing anyone can phish.">
      <div data-testid="passkeys-des1">
        {list.isPending ? (
          <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading passkeys"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
        ) : list.isError ? (
          <LoadErrorInline onRetry={() => void list.refetch()} />
        ) : list.data.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-xl bg-fill/50 p-4 sm:flex-row sm:items-center" data-testid="passkeys-empty">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-hover" aria-hidden><IconKey className="h-5 w-5" /></span>
            <p className="min-w-0 flex-1 text-sm text-muted">No passkeys yet. Add one on this device and you can sign in with a glance or a touch.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="Your passkeys">
            {list.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="passkey-row">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fill text-muted" aria-hidden><IconKey className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted">{p.device} · added {timeAgo(p.createdAt)} · {p.lastUsedAt ? `last used ${timeAgo(p.lastUsedAt)}` : "not used yet"}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" aria-label={`Rename ${p.name}`} onClick={async () => {
                    const name = await prompt({ title: "Rename passkey", label: "Name", initial: p.name, validate: requireText("a name") });
                    if (name) rename.mutate({ id: p.id, name });
                  }}>Rename</Button>
                  <Button variant="ghost" size="sm" className="text-bad hover:text-bad" aria-label={`Remove ${p.name}`} onClick={async () => {
                    if (await confirm({ title: `Remove ${p.name}?`, description: "You will not be able to sign in with it any more. You can always sign in the normal way.", confirmLabel: "Remove" })) remove.mutate(p.id);
                  }}>Remove</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {supported ? (
            <Button onClick={() => void add()} loading={adding} data-testid="passkey-add"><IconKey className="h-4 w-4" aria-hidden />Add a passkey</Button>
          ) : (
            <p className="text-sm text-muted">This browser cannot make passkeys. Try a recent Safari, Chrome, Edge or Firefox.</p>
          )}
        </div>
      </div>
      {dialogs}
    </Section>
  );
}
