import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
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
  Option,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from '@fluentui/react-components';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { DataTable } from '../../components/DataTable';
import { Page } from '../../components/Page';
import { LoadError } from '../DataCollection';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  primary_domain: string | null;
  status: string;
  teams_read_only: boolean;
  created_at: string;
}
interface Member {
  id: string;
  email: string;
  displayName: string;
  role: string;
  siteIds: string[] | null;
}
interface SiteRow {
  id: string;
  sitecode: string;
  name: string | null;
}
interface PlatformUser {
  id: string;
  email: string;
  display_name: string;
  role: string;
}

export function AdminTenants() {
  const qc = useQueryClient();
  const { refreshMe, setActiveTenant, can } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [domain, setDomain] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants') });
  const setReadOnly = useMutation({
    mutationFn: ({ id, teamsReadOnly }: { id: string; teamsReadOnly: boolean }) =>
      api(`/tenants/${id}`, { method: 'PATCH', body: JSON.stringify({ teamsReadOnly }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenants'] }),
  });
  const create = useMutation({
    mutationFn: () =>
      api<Tenant>('/tenants', {
        method: 'POST',
        body: JSON.stringify({ name, slug, primaryDomain: domain || undefined }),
      }),
    onSuccess: async (created) => {
      setName('');
      setSlug('');
      setDomain('');
      setErr(null);
      qc.invalidateQueries({ queryKey: ['tenants'] });
      // Pull the new customer into the header switcher and select it.
      await refreshMe();
      if (created?.id) setActiveTenant(created.id);
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  return (
    <Page
      title="Customers"
      subtitle="Each customer gets an isolated database schema, provisioned automatically on creation."
    >
      <Card>
        <Text weight="semibold">New customer</Text>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <Field label="Name">
            <Input value={name} onChange={(_, d) => setName(d.value)} />
          </Field>
          <Field label="Slug" hint="lowercase, hyphens">
            <Input
              value={slug}
              onChange={(_, d) => setSlug(d.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            />
          </Field>
          <Field label="Primary domain (optional)">
            <Input value={domain} onChange={(_, d) => setDomain(d.value)} placeholder="contoso.com" />
          </Field>
          <Button
            appearance="primary"
            disabled={!name || slug.length < 2 || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </div>
        {err && <Text style={{ color: '#b10e1c' }}>{err}</Text>}
      </Card>

      <Card>
        {list.isLoading ? (
          <Spinner size="tiny" />
        ) : list.isError ? (
          <LoadError message={(list.error as Error).message} />
        ) : (
          <DataTable size="small" minWidth={780}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Slug</TableHeaderCell>
                <TableHeaderCell>Domain</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Teams read-only</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{t.name}</TableCell>
                  <TableCell>{t.slug}</TableCell>
                  <TableCell>{t.primary_domain ?? '—'}</TableCell>
                  <TableCell>{t.status}</TableCell>
                  <TableCell>
                    {can('tenant:update') ? (
                      <Checkbox
                        checked={t.teams_read_only}
                        disabled={setReadOnly.isPending}
                        label={t.teams_read_only ? 'On' : 'Off'}
                        onChange={(_, d) => setReadOnly.mutate({ id: t.id, teamsReadOnly: !!d.checked })}
                      />
                    ) : t.teams_read_only ? (
                      <Badge appearance="tint" color="warning">
                        Read-only
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
        <Text size={200} style={{ color: '#616161' }}>
          When Teams read-only is on, the platform can never send a write cmdlet to that customer's
          live Microsoft Teams tenant - every deployment run is forced to dry-run, no matter what
          mode is requested. Discovery and validation (read-only) are unaffected.
        </Text>
      </Card>

      {list.data && list.data.length > 0 && <CustomerMembers tenants={list.data} />}
    </Page>
  );
}

/* --------------------------- members + site scope --------------------------- */

function CustomerMembers({ tenants }: { tenants: Tenant[] }) {
  const qc = useQueryClient();
  const [sel, setSel] = useState<string>(tenants[0]?.id ?? '');
  useEffect(() => {
    if (!tenants.some((t) => t.id === sel)) setSel(tenants[0]?.id ?? '');
  }, [tenants, sel]);

  const members = useQuery({
    queryKey: ['members', sel],
    enabled: !!sel,
    queryFn: () => api<Member[]>(`/tenants/${sel}/members`),
  });
  const sites = useQuery({
    queryKey: ['tenant-sites', sel],
    enabled: !!sel,
    queryFn: () => api<SiteRow[]>(`/tenants/${sel}/sites`),
  });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<PlatformUser[]>('/users') });

  const siteLabel = (id: string) => {
    const st = (sites.data ?? []).find((x) => x.id === id);
    return st ? st.sitecode : id.slice(0, 8);
  };

  const [scopeFor, setScopeFor] = useState<Member | null>(null);
  const [addUserId, setAddUserId] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const refetch = () => {
    qc.invalidateQueries({ queryKey: ['members', sel] });
  };

  const addMember = useMutation({
    mutationFn: () => api(`/tenants/${sel}/members`, { method: 'POST', body: JSON.stringify({ userId: addUserId }) }),
    onSuccess: () => {
      setAddUserId('');
      setErr(null);
      refetch();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  const memberIds = new Set((members.data ?? []).map((m) => m.id));
  const eligible = (users.data ?? []).filter((u) => u.role === 'CUSTOMER' && !memberIds.has(u.id));

  return (
    <Card>
      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
        <Text weight="semibold">Members &amp; site access</Text>
        <Field label="Customer">
          <Dropdown
            value={tenants.find((t) => t.id === sel)?.name ?? ''}
            selectedOptions={[sel]}
            onOptionSelect={(_, d) => d.optionValue && setSel(d.optionValue)}
            style={{ minWidth: 220 }}
          >
            {tenants.map((t) => (
              <Option key={t.id} value={t.id} text={t.name}>
                {t.name}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </div>

      {members.isLoading ? (
        <Spinner size="tiny" />
      ) : members.isError ? (
        <LoadError message={(members.error as Error).message} />
      ) : (
        <DataTable size="small" minWidth={760}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Email</TableHeaderCell>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Site access</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.data!.map((m) => {
              const ids = m.siteIds ?? [];
              return (
                <TableRow key={m.id}>
                  <TableCell>{m.displayName}</TableCell>
                  <TableCell>{m.email}</TableCell>
                  <TableCell>{m.role}</TableCell>
                  <TableCell>
                    {m.role !== 'CUSTOMER' ? (
                      <Text size={200}>Whole customer</Text>
                    ) : ids.length === 0 ? (
                      <Badge appearance="tint" color="informative">
                        Whole customer
                      </Badge>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {ids.map((id) => (
                          <Badge key={id} appearance="tint" color="brand">
                            {siteLabel(id)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {m.role === 'CUSTOMER' && (
                      <Button size="small" appearance="subtle" onClick={() => setScopeFor(m)}>
                        Edit scope
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </DataTable>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
        <Field label="Add an existing customer user">
          <Dropdown
            placeholder={eligible.length ? 'Select a user…' : 'No unassigned customer users'}
            selectedOptions={addUserId ? [addUserId] : []}
            value={eligible.find((u) => u.id === addUserId)?.email ?? ''}
            onOptionSelect={(_, d) => setAddUserId(d.optionValue ?? '')}
            style={{ minWidth: 260 }}
          >
            {eligible.map((u) => (
              <Option key={u.id} value={u.id} text={u.email}>
                {u.display_name} · {u.email}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Button appearance="primary" disabled={!addUserId || addMember.isPending} onClick={() => addMember.mutate()}>
          Add
        </Button>
      </div>
      {err && <Text style={{ color: '#b10e1c' }}>{err}</Text>}

      {scopeFor && (
        <ScopeDialog
          member={scopeFor}
          tenantId={sel}
          sites={sites.data ?? []}
          onClose={() => setScopeFor(null)}
          onSaved={() => {
            setScopeFor(null);
            refetch();
          }}
        />
      )}
    </Card>
  );
}

function ScopeDialog({
  member,
  tenantId,
  sites,
  onClose,
  onSaved,
}: {
  member: Member;
  tenantId: string;
  sites: SiteRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = member.siteIds ?? [];
  const [mode, setMode] = useState<'all' | 'sites'>(initial.length ? 'sites' : 'all');
  const [ids, setIds] = useState<string[]>(initial);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api(`/tenants/${tenantId}/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ siteIds: mode === 'sites' ? ids : [] }),
      }),
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Site access — {member.displayName}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'grid', gap: 12, minWidth: 380 }}>
              <Field label="Access">
                <Dropdown
                  value={mode === 'all' ? 'Whole customer' : 'Specific sites'}
                  selectedOptions={[mode]}
                  onOptionSelect={(_, d) => setMode((d.optionValue as 'all' | 'sites') ?? 'all')}
                >
                  <Option value="all">Whole customer</Option>
                  <Option value="sites">Specific sites</Option>
                </Dropdown>
              </Field>
              {mode === 'sites' && (
                <Field label="Sites" hint={sites.length === 0 ? 'This customer has no sites yet' : undefined}>
                  <Dropdown
                    multiselect
                    placeholder="Select sites…"
                    selectedOptions={ids}
                    value={ids
                      .map((id) => sites.find((st) => st.id === id)?.sitecode ?? id.slice(0, 6))
                      .join(', ')}
                    onOptionSelect={(_, d) => setIds(d.selectedOptions)}
                  >
                    {sites.map((st) => (
                      <Option key={st.id} value={st.id} text={st.sitecode}>
                        {st.sitecode}
                        {st.name ? ` — ${st.name}` : ''}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              {err && <Text style={{ color: '#b10e1c' }}>{err}</Text>}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onClose}>
                Cancel
              </Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              disabled={save.isPending || (mode === 'sites' && ids.length === 0)}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
