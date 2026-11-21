/**
 * OPS1: platform operators. Owners grant, change and remove operator roles (each asks for a reason and a recent sign
 * in); everyone else with access sees the list. Operators set on the server (PLATFORM_ADMIN_EMAILS) can't be changed here.
 * A role without operators.read (support, billing, read only) opening this address sees the calm "no access" card.
 */
import { useState } from "react";
import { Link } from "react-router";
import { Badge, PageHeader } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select } from "@/web/components/ui/input";
import { IconChevronDown, IconUserCog } from "@/web/components/ui/icon";
import { consoleApi, type ConsoleOperator } from "@/web/lib/console-api";
import { OPERATOR_ROLES, OPERATOR_ROLE_HINTS, OPERATOR_ROLE_LABELS, type OperatorRole } from "@/shared/operator-permissions";
import { DataTable } from "./components/data-table";
import { OperatorRoleBadge, RelTime, TwoStepBadge, personHref } from "./components/format";
import { useOperatorAction } from "./components/reason-dialog";
import { PermissionGate, RequirePermission, useConsoleMe, usePermission } from "./guard";

function RolePicker({ value, onChange, label = "Role" }: { value: OperatorRole; onChange: (r: OperatorRole) => void; label?: string }) {
  return (
    <Field label={label} hint={OPERATOR_ROLE_HINTS[value]}>
      {(p) => (
        <div className="relative">
          <Select {...p} value={value} onChange={(e) => onChange(e.target.value as OperatorRole)} data-testid="console-operator-role">
            {OPERATOR_ROLES.map((r) => <option key={r} value={r}>{OPERATOR_ROLE_LABELS[r]}</option>)}
          </Select>
          {/* The chevron that says this is a list (phones get the app's own picker button instead). */}
          <IconChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle max-sm:hidden" aria-hidden />
        </div>
      )}
    </Field>
  );
}

export function ConsoleOperatorsPage() {
  return (
    <RequirePermission permission="operators.read">
      <OperatorsList />
    </RequirePermission>
  );
}

function OperatorsList() {
  const me = useConsoleMe();
  const canManage = usePermission("operators.manage");
  const [email, setEmail] = useState("");
  const [grantRole, setGrantRole] = useState<OperatorRole>("ops_readonly");
  const [newRole, setNewRole] = useState<OperatorRole>("ops_readonly");
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const grant = useOperatorAction<void>({
    title: "Add an operator",
    description: "They need a Multies account with a confirmed email. They get access the next time they open the console.",
    confirmLabel: "Add operator",
    canSubmit: validEmail,
    fields: (
      <div className="space-y-4">
        <Field label="Email" hint={email && !validEmail ? "Enter the email address of their Multies account." : undefined}>
          {(p) => <Input {...p} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />}
        </Field>
        <RolePicker value={grantRole} onChange={setGrantRole} />
      </div>
    ),
    run: (_v, reason) => consoleApi.grantOperator({ email: email.trim(), role: grantRole, reason }),
    success: "Operator added",
    onDone: () => setEmail(""),
  });
  const change = useOperatorAction<ConsoleOperator>({
    title: (o) => `Change ${o.email}'s role`,
    description: (o) => `They are ${o.roleLabel} now. The new role applies on their next click in the console.`,
    confirmLabel: "Change role",
    fields: <RolePicker value={newRole} onChange={setNewRole} label="New role" />,
    run: (o, reason) => consoleApi.changeOperatorRole(o.id, { role: newRole, reason }),
    success: "Role changed",
  });
  const remove = useOperatorAction<ConsoleOperator>({
    title: (o) => `Remove ${o.email} as an operator?`,
    description: "They lose access to the console straight away. Their own Multies account and workspaces stay as they are.",
    confirmLabel: "Remove operator", tone: "danger",
    run: (o, reason) => consoleApi.removeOperator(o.id, { reason }),
    success: "Operator removed",
  });

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Access" title="Operators" description="The people who can open this console, and what each role allows."
        actions={<PermissionGate permission="operators.manage"><Button onClick={() => grant.open()} data-testid="add-operator">Add operator</Button></PermissionGate>} />
      <DataTable<ConsoleOperator>
        label="Operators" path="/operators" search={{ placeholder: "Search operators" }} defaultSort="email:asc"
        rowKey={(o) => o.id}
        empty={{ icon: <IconUserCog />, title: "No operators found", body: "Try another search." }}
        columns={[
          { key: "who", header: "Operator", sort: "email", cell: (o) => (
            <span className="flex flex-col">
              <span className="font-medium"><Link to={personHref(o.id)} className="hover:underline">{o.name}</Link>{o.id === me.user.id && <span className="ml-1.5 text-xs font-normal text-subtle">(you)</span>}</span>
              <span className="text-xs text-muted">{o.email}</span>
            </span>
          ) },
          { key: "role", header: "Role", cell: (o) => <span className="flex flex-wrap items-center gap-1.5"><OperatorRoleBadge role={o.role} />{o.envManaged && <span title="Set in PLATFORM_ADMIN_EMAILS on the server"><Badge className="whitespace-nowrap">Set on the server</Badge></span>}</span> },
          { key: "2fa", header: "Two-step sign in", cell: (o) => <TwoStepBadge on={o.twoFactor} /> },
          { key: "last", header: "Last sign in", secondary: true, cell: (o) => <RelTime at={o.lastSignInAt} empty="No sign in yet" className="text-muted" /> },
          { key: "actions", header: "", align: "right", cell: (o) => (canManage && !o.envManaged ? (
            <span className="inline-flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => { setNewRole(o.role); change.open(o); }}>Change role</Button>
              <Button size="sm" variant="ghost" onClick={() => remove.open(o)}>Remove</Button>
            </span>
          ) : null) },
        ]}
      />
      {grant.dialog}{change.dialog}{remove.dialog}
    </div>
  );
}
