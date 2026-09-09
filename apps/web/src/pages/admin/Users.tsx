import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from '@fluentui/react-components';
import {
  CheckmarkRegular,
  CopyRegular,
  DeleteRegular,
  MailRegular,
  PeopleTeamRegular,
} from '@fluentui/react-icons';
import { ROLES, type Role } from '@tvmf/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Page } from '../../components/Page';
import { LoadError } from '../../components/records';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  totp_enrolled: boolean;
  tenants?: { id: string; name: string }[];
}
interface TenantRow {
  id: string;
  name: string;
}
interface SiteRow {
  id: string;
  sitecode: string;
  name: string | null;
}
interface Membership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  siteIds: string[];
}

/**
 * Copy-to-clipboard that also works outside a secure context (e.g. the app
 * reached over plain http on the LAN), where `navigator.clipboard` is undefined.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked - the password is still selectable in the banner */
    }
  };

  return (
    <Button
      size="small"
      icon={copied ? <CheckmarkRegular /> : <CopyRegular />}
      onClick={() => void copy()}
    >
      {copied ? 'Copied' : 'Copy password'}
    </Button>
  );
}

const useSites = (tenantId: string) =>
  useQuery({
    queryKey: ['tenant-sites', tenantId],
    enabled: !!tenantId,
    queryFn: () => api<SiteRow[]>(`/tenants/${tenantId}/sites`),
  });

/** Hard-delete an account, behind a confirmation dialog. SUPER_ADMIN only. */
function DeleteUserButton({ user, onDeleted }: { user: UserRow; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const del = useMutation({
    mutationFn: () => api(`/users/${user.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setOpen(false);
      onDeleted();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  return (
    <>
      <Button
        size="small"
        appearance="subtle"
        icon={<DeleteRegular />}
        style={{ color: '#b10e1c' }}
        onClick={() => {
          setErr(null);
          setOpen(true);
        }}
      >
        Delete
      </Button>
      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete {user.display_name}?</DialogTitle>
            <DialogContent>
              This permanently removes <b>{user.email}</b>. Their sign-in sessions, two-factor
              enrolment and customer assignments are deleted with the account. This cannot be
              undone.
              {err && (
                <Text style={{ color: '#b10e1c', display: 'block', marginTop: 8 }}>{err}</Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                style={{ backgroundColor: '#b10e1c' }}
                disabled={del.isPending}
                onClick={() => del.mutate()}
              >
                Delete account
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

export function AdminUsers() {
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('ENGINEER');
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [siteScope, setSiteScope] = useState<'all' | 'sites'>('all');
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [manage, setManage] = useState<UserRow | null>(null);
  const [invited, setInvited] = useState<{
    email: string;
    tempPassword: string;
    resent: boolean;
  } | null>(null);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/users') });
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<TenantRow[]>('/tenants') });

  const scopeTenantId = role === 'CUSTOMER' && tenantIds.length === 1 ? tenantIds[0] : null;
  const sites = useSites(scopeTenantId ?? '');

  const resetForm = () => {
    setEmail('');
    setDisplayName('');
    setTenantIds([]);
    setSiteScope('all');
    setSiteIds([]);
    setErr(null);
  };

  const create = useMutation({
    mutationFn: () =>
      api<{ email: string; tempPassword: string }>('/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          displayName,
          role,
          tenantIds: role === 'SUPER_ADMIN' ? undefined : tenantIds,
          siteIds:
            role === 'CUSTOMER' && scopeTenantId && siteScope === 'sites' ? siteIds : undefined,
        }),
      }),
    onSuccess: (data) => {
      resetForm();
      setInvited({ email: data.email, tempPassword: data.tempPassword, resent: false });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'disable' | 'enable' | 'reset-mfa' }) =>
      api(`/users/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const resend = useMutation({
    mutationFn: (id: string) =>
      api<{ email: string; tempPassword: string }>(`/users/${id}/resend-invitation`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      setInvited({ email: data.email, tempPassword: data.tempPassword, resent: true });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  return (
    <Page title="Users" subtitle="Platform staff and customer users, and which customers they can work in.">
      {invited && (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>
              {invited.resent ? 'New invitation sent' : 'Invitation sent'} to {invited.email}
            </MessageBarTitle>
            Temporary password:{' '}
            <code
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                background: 'rgba(0,0,0,0.06)',
                padding: '2px 6px',
                borderRadius: 4,
              }}
            >
              {invited.tempPassword}
            </code>
            . It&rsquo;s in the email; share it another way only if email isn&rsquo;t set up yet.
            Shown once.
          </MessageBarBody>
          <MessageBarActions>
            <CopyButton text={invited.tempPassword} />
            <Button size="small" appearance="subtle" onClick={() => setInvited(null)}>
              Dismiss
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
      <Card>
        <Text weight="semibold">New user</Text>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <Field label="Email">
            <Input type="email" value={email} onChange={(_, d) => setEmail(d.value)} />
          </Field>
          <Field label="Display name">
            <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} />
          </Field>
          <Field label="Role">
            <Dropdown
              value={role}
              selectedOptions={[role]}
              onOptionSelect={(_, d) => d.optionValue && setRole(d.optionValue as Role)}
            >
              {ROLES.map((r) => (
                <Option key={r} value={r}>
                  {r}
                </Option>
              ))}
            </Dropdown>
          </Field>
          {role !== 'SUPER_ADMIN' && (
            <Field
              label={role === 'CUSTOMER' ? 'Customer (exactly one)' : 'Assigned customers (one or more)'}
            >
              <Dropdown
                multiselect
                placeholder="Select…"
                selectedOptions={tenantIds}
                onOptionSelect={(_, d) => setTenantIds(d.selectedOptions)}
                style={{ minWidth: 220 }}
              >
                {(tenants.data ?? []).map((t) => (
                  <Option key={t.id} value={t.id}>
                    {t.name}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          )}
          {scopeTenantId && (
            <Field label="Site access" hint="Limit a site contact to specific sites">
              <Dropdown
                value={siteScope === 'all' ? 'Whole customer' : 'Specific sites'}
                selectedOptions={[siteScope]}
                onOptionSelect={(_, d) => setSiteScope((d.optionValue as 'all' | 'sites') ?? 'all')}
                style={{ minWidth: 200 }}
              >
                <Option value="all">Whole customer</Option>
                <Option value="sites">Specific sites</Option>
              </Dropdown>
            </Field>
          )}
          {scopeTenantId && siteScope === 'sites' && (
            <Field
              label="Sites"
              hint={sites.data && sites.data.length === 0 ? 'This customer has no sites yet' : undefined}
            >
              <Dropdown
                multiselect
                placeholder="Select sites…"
                selectedOptions={siteIds}
                value={siteLabels(siteIds, sites.data ?? [])}
                onOptionSelect={(_, d) => setSiteIds(d.selectedOptions)}
                style={{ minWidth: 220 }}
              >
                {(sites.data ?? []).map((st) => (
                  <Option key={st.id} value={st.id} text={st.sitecode}>
                    {st.sitecode}
                    {st.name ? ` — ${st.name}` : ''}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          )}
          <Button
            appearance="primary"
            disabled={
              !email ||
              !displayName ||
              create.isPending ||
              (!!scopeTenantId && siteScope === 'sites' && siteIds.length === 0)
            }
            onClick={() => create.mutate()}
          >
            Create & invite
          </Button>
        </div>
        <Text size={200} style={{ color: '#666' }}>
          The user is emailed a temporary password and must set their own password, then set up
          two-factor authentication, on first sign-in. Change their customers and site access any
          time with <b>Manage</b> below.
        </Text>
        {err && <Text style={{ color: '#b10e1c' }}>{err}</Text>}
      </Card>

      <Card>
        {users.isLoading ? (
          <Spinner size="tiny" />
        ) : users.isError ? (
          <LoadError message={(users.error as Error).message} />
        ) : (
          <div style={{ overflowX: 'auto', overflowY: 'hidden', paddingBottom: 2 }}>
          <Table size="small" style={{ minWidth: 'max-content' }}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell style={{ whiteSpace: 'nowrap' }}>Name</TableHeaderCell>
                <TableHeaderCell style={{ whiteSpace: 'nowrap' }}>Email</TableHeaderCell>
                <TableHeaderCell style={{ whiteSpace: 'nowrap' }}>Role</TableHeaderCell>
                <TableHeaderCell style={{ whiteSpace: 'nowrap' }}>Customers</TableHeaderCell>
                <TableHeaderCell style={{ whiteSpace: 'nowrap' }}>Status</TableHeaderCell>
                <TableHeaderCell style={{ whiteSpace: 'nowrap' }}>MFA</TableHeaderCell>
                <TableHeaderCell style={{ whiteSpace: 'nowrap', width: '1%' }}>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data!.map((u) => {
                const customers =
                  u.role === 'SUPER_ADMIN'
                    ? 'all'
                    : (u.tenants ?? []).map((t) => t.name).join(', ') || '—';
                return (
                <TableRow key={u.id}>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>{u.display_name}</TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>{u.email}</TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>{u.role}</TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>
                    <span
                      title={customers}
                      style={{
                        display: 'inline-block',
                        maxWidth: 260,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        verticalAlign: 'middle',
                      }}
                    >
                      {customers}
                    </span>
                  </TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>{u.status}</TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>
                    {u.totp_enrolled ? 'enrolled' : '—'}
                  </TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'nowrap' }}>
                      {u.role !== 'SUPER_ADMIN' && (
                        <Button
                          size="small"
                          appearance="primary"
                          icon={<PeopleTeamRegular />}
                          onClick={() => setManage(u)}
                        >
                          Manage
                        </Button>
                      )}
                      <Button
                        size="small"
                        onClick={() =>
                          act.mutate({ id: u.id, action: u.status === 'active' ? 'disable' : 'enable' })
                        }
                      >
                        {u.status === 'active' ? 'Disable' : 'Enable'}
                      </Button>
                      <Button size="small" onClick={() => act.mutate({ id: u.id, action: 'reset-mfa' })}>
                        Reset MFA
                      </Button>
                      {u.role !== 'SUPER_ADMIN' && (
                        <Button
                          size="small"
                          icon={<MailRegular />}
                          disabled={resend.isPending}
                          onClick={() => resend.mutate(u.id)}
                        >
                          Resend invite
                        </Button>
                      )}
                      {can('user:delete') && u.id !== me?.id && (
                        <DeleteUserButton
                          user={u}
                          onDeleted={() => qc.invalidateQueries({ queryKey: ['users'] })}
                        />
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </div>
        )}
      </Card>

      {manage && (
        <UserMembershipsDialog
          user={manage}
          tenants={tenants.data ?? []}
          onClose={() => setManage(null)}
        />
      )}
    </Page>
  );
}

/* --------------------- per-user membership management --------------------- */

function UserMembershipsDialog({
  user,
  tenants,
  onClose,
}: {
  user: UserRow;
  tenants: TenantRow[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const memberships = useQuery({
    queryKey: ['user-memberships', user.id],
    queryFn: () => api<Membership[]>(`/users/${user.id}/memberships`),
  });
  const refetch = () => {
    qc.invalidateQueries({ queryKey: ['user-memberships', user.id] });
    qc.invalidateQueries({ queryKey: ['users'] });
  };
  const taken = new Set((memberships.data ?? []).map((m) => m.tenantId));

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>
            {user.display_name} — customer access{' '}
            <Badge appearance="tint" color="informative">
              {user.role}
            </Badge>
          </DialogTitle>
          <DialogContent>
            <div style={{ display: 'grid', gap: 14, minWidth: 520 }}>
              {memberships.isLoading ? (
                <Spinner size="tiny" />
              ) : memberships.isError ? (
                <LoadError message={(memberships.error as Error).message} />
              ) : memberships.data!.length === 0 ? (
                <Text size={200}>Not assigned to any customer yet.</Text>
              ) : (
                <Table size="small">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Customer</TableHeaderCell>
                      <TableHeaderCell>Site access</TableHeaderCell>
                      <TableHeaderCell />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {memberships.data!.map((m) => (
                      <MembershipRow key={m.tenantId} user={user} m={m} onChanged={refetch} />
                    ))}
                  </TableBody>
                </Table>
              )}
              <AddMembershipRow
                user={user}
                tenants={tenants}
                taken={taken}
                onChanged={refetch}
              />
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onClose}>
                Close
              </Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Collapsed-display text for a multiselect site Dropdown. */
const siteLabels = (ids: string[], sites: SiteRow[]) =>
  ids
    .map((id) => sites.find((st) => st.id === id)?.sitecode ?? id.slice(0, 6))
    .join(', ');

function MembershipRow({
  user,
  m,
  onChanged,
}: {
  user: UserRow;
  m: Membership;
  onChanged: () => void;
}) {
  const isCustomer = user.role === 'CUSTOMER';
  const sites = useSites(isCustomer ? m.tenantId : '');
  const [mode, setMode] = useState<'all' | 'sites'>(m.siteIds.length ? 'sites' : 'all');
  const [ids, setIds] = useState<string[]>(m.siteIds);
  const [err, setErr] = useState<string | null>(null);

  const dirty =
    isCustomer &&
    (mode === 'all' ? m.siteIds.length > 0 : !sameIds(ids, m.siteIds) || m.siteIds.length === 0);

  const save = useMutation({
    mutationFn: () =>
      api(`/tenants/${m.tenantId}/members/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ siteIds: mode === 'sites' ? ids : [] }),
      }),
    onSuccess: () => {
      setErr(null);
      onChanged();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });
  const remove = useMutation({
    mutationFn: () => api(`/tenants/${m.tenantId}/members/${user.id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  return (
    <TableRow>
      <TableCell>{m.tenantName}</TableCell>
      <TableCell>
        {isCustomer ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Dropdown
              size="small"
              value={mode === 'all' ? 'Whole customer' : 'Specific sites'}
              selectedOptions={[mode]}
              onOptionSelect={(_, d) => setMode((d.optionValue as 'all' | 'sites') ?? 'all')}
              style={{ minWidth: 140 }}
            >
              <Option value="all">Whole customer</Option>
              <Option value="sites">Specific sites</Option>
            </Dropdown>
            {mode === 'sites' && (
              <Dropdown
                size="small"
                multiselect
                placeholder="Select sites…"
                selectedOptions={ids}
                value={siteLabels(ids, sites.data ?? [])}
                onOptionSelect={(_, d) => setIds(d.selectedOptions)}
                style={{ minWidth: 190 }}
              >
                {(sites.data ?? []).map((st) => (
                  <Option key={st.id} value={st.id} text={st.sitecode}>
                    {st.sitecode}
                    {st.name ? ` — ${st.name}` : ''}
                  </Option>
                ))}
              </Dropdown>
            )}
            {dirty && (
              <Button
                size="small"
                appearance="primary"
                disabled={save.isPending || (mode === 'sites' && ids.length === 0)}
                onClick={() => save.mutate()}
              >
                Save
              </Button>
            )}
          </div>
        ) : (
          <Text size={200}>Whole customer</Text>
        )}
        {err && <Text size={200} style={{ color: '#b10e1c' }}>{err}</Text>}
      </TableCell>
      <TableCell>
        <Button
          size="small"
          appearance="subtle"
          icon={<DeleteRegular />}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          Remove
        </Button>
      </TableCell>
    </TableRow>
  );
}

function AddMembershipRow({
  user,
  tenants,
  taken,
  onChanged,
}: {
  user: UserRow;
  tenants: TenantRow[];
  taken: Set<string>;
  onChanged: () => void;
}) {
  const isCustomer = user.role === 'CUSTOMER';
  const [tid, setTid] = useState('');
  const [mode, setMode] = useState<'all' | 'sites'>('all');
  const [ids, setIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const sites = useSites(isCustomer ? tid : '');
  const options = tenants.filter((t) => !taken.has(t.id));

  const add = useMutation({
    mutationFn: () =>
      api(`/tenants/${tid}/members`, {
        method: 'POST',
        body: JSON.stringify({
          userId: user.id,
          siteIds: isCustomer && mode === 'sites' ? ids : [],
        }),
      }),
    onSuccess: () => {
      setTid('');
      setMode('all');
      setIds([]);
      setErr(null);
      onChanged();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  if (isCustomer && taken.size >= 1) {
    return (
      <Text size={200} style={{ color: '#666' }}>
        Customer users belong to a single customer. Remove the current one first to move them.
      </Text>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
      <Field label="Add to customer">
        <Dropdown
          placeholder={options.length ? 'Select…' : 'All customers assigned'}
          selectedOptions={tid ? [tid] : []}
          value={options.find((t) => t.id === tid)?.name ?? ''}
          onOptionSelect={(_, d) => {
            setTid(d.optionValue ?? '');
            setIds([]);
            setMode('all');
          }}
          style={{ minWidth: 220 }}
        >
          {options.map((t) => (
            <Option key={t.id} value={t.id}>
              {t.name}
            </Option>
          ))}
        </Dropdown>
      </Field>
      {isCustomer && tid && (
        <>
          <Field label="Site access">
            <Dropdown
              value={mode === 'all' ? 'Whole customer' : 'Specific sites'}
              selectedOptions={[mode]}
              onOptionSelect={(_, d) => setMode((d.optionValue as 'all' | 'sites') ?? 'all')}
              style={{ minWidth: 160 }}
            >
              <Option value="all">Whole customer</Option>
              <Option value="sites">Specific sites</Option>
            </Dropdown>
          </Field>
          {mode === 'sites' && (
            <Field label="Sites">
              <Dropdown
                multiselect
                placeholder="Select sites…"
                selectedOptions={ids}
                value={siteLabels(ids, sites.data ?? [])}
                onOptionSelect={(_, d) => setIds(d.selectedOptions)}
                style={{ minWidth: 200 }}
              >
                {(sites.data ?? []).map((st) => (
                  <Option key={st.id} value={st.id} text={st.sitecode}>
                    {st.sitecode}
                    {st.name ? ` — ${st.name}` : ''}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          )}
        </>
      )}
      <Button
        appearance="primary"
        disabled={!tid || add.isPending || (isCustomer && mode === 'sites' && ids.length === 0)}
        onClick={() => add.mutate()}
      >
        Add
      </Button>
      {err && <Text size={200} style={{ color: '#b10e1c' }}>{err}</Text>}
    </div>
  );
}
