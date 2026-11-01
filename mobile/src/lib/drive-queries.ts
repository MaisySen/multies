import { useMemo } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HttpTransport } from "@/api/transport";
import { useSession } from "./session";
import { useWebConfig } from "./web-config";
import { success, warning } from "./haptics";
import { driveApi, isAdminRole, type DriveDetail, type DriveList, type DriveSpace, type DriveView } from "./drive";
import { uploadToDrive, uploadVersion, type DriveIo } from "./drive-files";
import type { PickedFile } from "./tools";

/** M1: React Query hooks for the drive. Lists refresh after every change; the server decides every action. */
export const driveKeys = {
  all: ["drive"] as const,
  list: (view: DriveView, folder: string | null, q: string) => ["drive", "list", view, folder ?? "", q] as const,
  usage: ["drive", "usage"] as const,
  tags: ["drive", "tags"] as const,
  detail: (id: string) => ["drive", "detail", id] as const,
};

export function useDrive() {
  const { transport } = useSession();
  return useMemo(() => driveApi(transport), [transport]);
}

/** The bytes side: the phone's own uploader and downloader with the session, or the sample transport. */
export function useDriveIo(): DriveIo {
  const { transport } = useSession();
  return useMemo(() => ({ auth: transport instanceof HttpTransport ? transport.fileAuth() : null, transport }), [transport]);
}

/**
 * Whether this person gets Files: the web's filesPlus flag is on and the session is a workspace member.
 * Project guests and client portal visitors have no workspace on their session, so they never see it.
 */
export function useFilesAccess(): { on: boolean; admin: boolean; pending: boolean } {
  const { me } = useSession();
  const cfg = useWebConfig();
  const member = !!me?.organization;
  return { on: member && !!cfg.data?.filesPlus, admin: isAdminRole(me?.organization?.role), pending: cfg.isPending };
}

export function useDriveList(view: DriveView, folder: string | null, q: string, enabled = true) {
  const api = useDrive();
  return useInfiniteQuery({
    queryKey: driveKeys.list(view, folder, q),
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.list({ view, folder, q, cursor: pageParam }),
    getNextPageParam: (last: DriveList) => last.next,
    retry: (n, e) => { const s = (e as { status?: number })?.status; return s !== 401 && s !== 403 && s !== 404 && s !== 422 && n < 2; },
  });
}

export function useDriveUsage(enabled = true) {
  const api = useDrive();
  return useQuery({ queryKey: driveKeys.usage, enabled, queryFn: () => api.usage(), staleTime: 60_000, retry: false });
}

export function useDriveTags(enabled = true) {
  const api = useDrive();
  return useQuery({ queryKey: driveKeys.tags, enabled, queryFn: async () => (await api.tags()).tags, staleTime: 60_000, retry: false });
}

export function useDriveDetail(id: string | null, trashed = false) {
  const api = useDrive();
  return useQuery({ queryKey: driveKeys.detail(id ?? ""), enabled: !!id, queryFn: () => api.detail(id!, trashed), retry: (n, e) => { const s = (e as { status?: number })?.status; return !s || (s >= 500 && n < 2); } });
}

export function useDriveActions() {
  const api = useDrive();
  const io = useDriveIo();
  const qc = useQueryClient();
  const settle = () => qc.invalidateQueries({ queryKey: driveKeys.all });
  const ok = () => success();
  const bad = () => warning();
  const putDetail = (d: DriveDetail) => qc.setQueryData(driveKeys.detail(d.item.id), d);
  return {
    createFolder: useMutation({ mutationFn: (b: { space: DriveSpace; parentId: string | null; name: string }) => api.createFolder(b), onSuccess: ok, onError: bad, onSettled: settle }),
    rename: useMutation({ mutationFn: (b: { id: string; name: string }) => api.update(b.id, { name: b.name }), onSuccess: ok, onError: bad, onSettled: settle }),
    setNote: useMutation({ mutationFn: (b: { id: string; note: string | null }) => api.update(b.id, { note: b.note }), onSuccess: ok, onError: bad, onSettled: settle }),
    setTags: useMutation({ mutationFn: (b: { id: string; tags: string[] }) => api.update(b.id, { tags: b.tags }), onSuccess: ok, onError: bad, onSettled: settle }),
    move: useMutation({ mutationFn: (b: { ids: string[]; parentId: string | null; space?: DriveSpace }) => api.move(b), onSuccess: ok, onError: bad, onSettled: settle }),
    star: useMutation({ mutationFn: (b: { ids: string[]; on: boolean }) => api.star(b.ids, b.on), onError: bad, onSettled: settle }),
    trash: useMutation({ mutationFn: (ids: string[]) => api.trash(ids), onSuccess: ok, onError: bad, onSettled: settle }),
    restore: useMutation({ mutationFn: (ids: string[]) => api.restore(ids), onSuccess: ok, onError: bad, onSettled: settle }),
    restoreVersion: useMutation({ mutationFn: (b: { id: string; vid: string }) => api.restoreVersion(b.id, b.vid), onSuccess: (d) => { putDetail(d); ok(); }, onError: bad, onSettled: settle }),
    upload: useMutation({
      mutationFn: (b: { target: { space: DriveSpace; parentId: string | null }; file: PickedFile; onProgress?: (f: number) => void }) => uploadToDrive(io, b.target, b.file, b.onProgress),
      onError: bad, onSettled: settle,
    }),
    newVersion: useMutation({
      mutationFn: (b: { id: string; file: PickedFile; onProgress?: (f: number) => void }) => uploadVersion(io, b.id, b.file, b.onProgress),
      onSuccess: (d) => { putDetail(d); ok(); }, onError: bad, onSettled: settle,
    }),
  };
}
