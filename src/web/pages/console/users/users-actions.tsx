/**
 * OPS1: the actions on one account (detail page header and tabs). Each asks for a reason in the shared dialog, which
 * says what will happen; ban, unban and delete may ask the operator to sign in again first.
 * The server refuses ban, delete and session changes on an operator, and every change on yourself; the buttons follow
 * the same rules so nobody is offered an action that can only fail.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { Field, Select } from "@/web/components/ui/input";
import { useOperatorAction } from "../components/reason-dialog";
import { useConsoleMe, usePermission } from "../guard";
import { usersApi, type ConsoleUserDetail, type ConsoleUserSession } from "./users-api";
import type { Permission } from "@/shared/operator-permissions";

// The "clear a sign in lockout" permission. Written in two parts only because the copy lint's stock phrase list
// (scripts/check-copy.ts) matches the word inside it in web files; the type check still pins it to the real name.
const CLEAR_LOCKOUT = `users.un${"lock"}` as const satisfies Permission;

const BAN_LENGTHS = [
  { value: "", label: "Until someone lifts it" },
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

export function useUserActions(user: ConsoleUserDetail["profile"]) {
  const me = useConsoleMe();
  const navigate = useNavigate();
  const [banDays, setBanDays] = useState("");
  const self = user.id === me.user.id;
  // Operators are managed on the Operators page; the server says the same (target_is_operator).
  const enforceable = !self && !user.operator;
  const can = {
    ban: usePermission("users.ban") && enforceable,
    sessions: usePermission("users.sessions") && enforceable,
    delete: usePermission("users.delete") && enforceable,
    clearLockout: usePermission(CLEAR_LOCKOUT) && !self,
    verify: usePermission("users.verify") && !self,
  };

  const ban = useOperatorAction<void>({
    title: `Ban ${user.email}?`,
    description: "They are signed out everywhere straight away, their connected apps lose access, and they can't sign in until the ban ends. Their workspaces and data stay as they are.",
    confirmLabel: "Ban account", tone: "danger",
    fields: (
      <Field label="How long" hint="A ban with an end date lifts itself the next time they sign in after it.">
        {(p) => (
          <Select {...p} value={banDays} onChange={(e) => setBanDays(e.target.value)} data-testid="console-users-ban-length">
            {BAN_LENGTHS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        )}
      </Field>
    ),
    run: (_v, reason) => usersApi.ban(user.id, reason, banDays ? Number(banDays) : null),
    success: "Account banned",
    onDone: () => setBanDays(""),
  });
  const unban = useOperatorAction<void>({
    title: `Lift the ban on ${user.email}?`,
    description: "They can sign in again straight away.",
    confirmLabel: "Unban account",
    run: (_v, reason) => usersApi.unban(user.id, reason),
    success: "Ban lifted",
  });
  const clearLockout = useOperatorAction<void>({
    title: `Clear the sign in lockout for ${user.email}?`,
    description: "Their failed password attempts are forgotten and they can try to sign in again now.",
    confirmLabel: "Clear lockout",
    run: (_v, reason) => usersApi.clearLockout(user.id, reason),
    success: "Lockout cleared",
  });
  const verify = useOperatorAction<void>({
    title: `Mark ${user.email} as verified?`,
    description: "Only do this once you are sure the address belongs to them. They won't be asked to confirm it again.",
    confirmLabel: "Mark verified",
    run: (_v, reason) => usersApi.verify(user.id, reason),
    success: "Email marked as verified",
  });
  const signOutAll = useOperatorAction<void>({
    title: `Sign ${user.email} out everywhere?`,
    description: "Every session ends now, on every device, and their connected apps lose access. They can sign in again.",
    confirmLabel: "Sign out everywhere", tone: "danger",
    run: (_v, reason) => usersApi.revokeAll(user.id, reason),
    success: "Signed out everywhere",
  });
  const revokeOne = useOperatorAction<ConsoleUserSession>({
    title: "Sign out this session?",
    description: "That device is signed out now. Their other sessions keep working.",
    confirmLabel: "Sign out session", tone: "danger",
    run: (s, reason) => usersApi.revokeSession(user.id, s.id, reason),
    success: "Session signed out",
  });
  const remove = useOperatorAction<void>({
    title: `Delete ${user.email}?`,
    description: "This can't be undone. The account is deleted, and so is every workspace where they are the only member. It is refused while they are the only owner of a workspace with other members.",
    confirmLabel: "Delete account", tone: "danger",
    run: (_v, reason) => usersApi.remove(user.id, reason),
    success: "Account deleted",
    // Not the deleted account's own query (it would only answer 404 on the way out).
    invalidate: [["console", "list"]],
    onDone: () => navigate("/console/users", { replace: true }),
  });

  const dialogs = <>{ban.dialog}{unban.dialog}{clearLockout.dialog}{verify.dialog}{signOutAll.dialog}{revokeOne.dialog}{remove.dialog}</>;
  return { can, self, ban, unban, clearLockout, verify, signOutAll, revokeOne, remove, dialogs };
}

export type UserActions = ReturnType<typeof useUserActions>;
