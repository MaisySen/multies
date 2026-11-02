/**
 * M2 (1.10.10): React Query hooks for Expenses. Nothing is kept on the phone.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import { useSession } from "./session";
import { noAccess, notFoundErr } from "./contacts-queries";
import { useDriveIo } from "./drive-queries";
import { uploadRaw } from "./drive-files";
import { typeForName, type PickedFile } from "./tools";
import { toNumber } from "./native-number";
import { RECEIPT_TYPES, receiptUploadPath, type Expense, type ExpensesResponse } from "./expenses";

export const expenseKeys = { all: ["expenses"] as const };
const retry = (k: number, e: unknown) => !noAccess(e) && !notFoundErr(e) && k < 2;

export function useExpenses(view: "mine" | "approve") {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...expenseKeys.all, mode, view], retry, queryFn: () => transport.request<ExpensesResponse>("GET", `/expenses?view=${view}`) });
}

export function useExpense(id: string | undefined) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...expenseKeys.all, mode, "one", id ?? ""], enabled: !!id, retry,
    queryFn: () => transport.request<{ expense: Expense }>("GET", `/expenses/${encodeURIComponent(id!)}`).then((r) => r.expense) });
}

export async function pickReceipt(): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true, type: RECEIPT_TYPES });
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  return { uri: a.uri, name: a.name || "receipt", size: toNumber(a.size), type: a.mimeType || typeForName(a.name || "") };
}

/** Uploads a receipt, then asks the server to read it (supplier, total and GST fill in by themselves). */
export function useAddReceipt() {
  const io = useDriveIo();
  const { transport } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (f: PickedFile) => {
      const { expense } = await uploadRaw<{ expense: Expense }>(io, receiptUploadPath(f.name), f);
      await transport.request("POST", `/expenses/${encodeURIComponent(expense.id)}/read`).catch(() => undefined);
      return expense;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: expenseKeys.all }),
  });
}

export function useExpenseAction() {
  const { transport } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "submit" | "withdraw" }) => transport.request<{ expense: Expense }>("POST", `/expenses/${encodeURIComponent(id)}/${action}`),
    onSettled: () => qc.invalidateQueries({ queryKey: expenseKeys.all }),
  });
}
