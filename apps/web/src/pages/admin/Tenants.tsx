import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Select,
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
  SearchBox,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  tokens,

  makeStyles,
  shorthands,
} from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import type { Branding } from '@tvmf/shared';
import { api, apiUpload } from '../../api';
import { useAuth } from '../../auth';
import { DataTable } from '../../components/DataTable';
import { Page } from '../../components/Page';
import { Wordmark } from '../../components/Logo';
import { useDebounced } from '../../hooks/useDebounced';
import { DeleteCustomerDialog } from './DeleteCustomerDialog';
import { LoadError } from '../DataCollection';
import { DangerText, MutedText } from '../../components/ui';
import { TableSkeleton } from '../../components/states';

const useLocalStyles = makeStyles({
  flexWrapItemsEndGap12: { display: "flex", ...shorthands.gap('12px'), flexWrap: "wrap", alignItems: "end" },
  w40H32FilledPad0: { width: '40px', height: '32px', ...shorthands.padding("0px"), ...shorthands.border("0"), backgroundColor: "none", cursor: "pointer" },
  maxW320: { maxWidth: '320px' },
  flexItemsCenterGap8: { display: "flex", alignItems: "center", ...shorthands.gap('8px') },
  blockWAutoH20: { height: '20px', width: "auto", display: "block" },
  gridGap4: { display: "grid", ...shorthands.gap('4px') },
  gridGap12MinW380: { display: "grid", ...shorthands.gap('12px'), minWidth: '380px' },
  flexItemsCenterGap12: { display: "flex", alignItems: "center", ...shorthands.gap('12px') },
  wAutoH40: { height: '40px', width: "auto" },
  flexWrapItemsEndGap122: { display: "flex", ...shorthands.gap('12px'), alignItems: "end", flexWrap: "wrap" },
  minW220: { minWidth: '220px' },
  flexWrapGap4: { display: "flex", ...shorthands.gap('4px'), flexWrap: "wrap" },
  flexWrapItemsEndGap8: { display: "flex", ...shorthands.gap('8px'), alignItems: "end", flexWrap: "wrap" },
  minW260: { minWidth: '260px' },
  dangerZone: { color: tokens.colorPaletteRedForeground1, borderLeft: `1px solid ${tokens.colorNeutralStroke2}`, paddingLeft: '12px' },
  pendingRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...shorthands.gap('12px'), flexWrap: 'wrap' },
});


const DEFAULT_ACCENT = '#4657D2';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  primary_domain: string | null;
  status: string;
  teams_read_only: boolean;
  managed_services_enabled: boolean;
  monitoring_enabled: boolean;
  msp_id: string | null;
  branding: Branding | null;
  sandbox: boolean;
  sandbox_email: string | null;
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
  const ls = useLocalStyles();
  const qc = useQueryClient();
  const { refreshMe, setActiveTenant, can, featureOn } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [domain, setDomain] = useState('');
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sandboxErr, setSandboxErr] = useState<string | null>(null);
  const [brandingFor, setBrandingFor] = useState<Tenant | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string; resume?: boolean } | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput);
  const list = useQuery({
    queryKey: ['tenants', search],
    queryFn: () => api<Tenant[]>(`/tenants${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });
  // Unfiltered, for CustomerMembers' customer picker below - that's a
  // different concern (which customer to manage members for) and shouldn't
  // shrink/disappear just because the branding table above is being searched.
  const allTenants = useQuery({ queryKey: ['tenants', 'all'], queryFn: () => api<Tenant[]>('/tenants') });
  // Customers whose deletion started and did not finish. They are hidden everywhere else; only a Super Admin sees them, here.
  const pendingDeletion = useQuery({
    queryKey: ['tenants', 'pending-deletion'],
    enabled: can('tenant:delete'),
    queryFn: () => api<{ id: string; name: string; slug: string }[]>('/tenants/pending-deletion'),
  });
  const setReadOnly = useMutation({
    mutationFn: ({ id, teamsReadOnly }: { id: string; teamsReadOnly: boolean }) =>
      api(`/tenants/${id}`, { method: 'PATCH', body: JSON.stringify({ teamsReadOnly }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenants'] }),
  });
  const mspList = useQuery({
    queryKey: ['msps', 'all'],
    enabled: can('tenant:update') && featureOn('msp'),
    queryFn: () => api<{ id: string; name: string }[]>('/msps'),
  });
  const setMsp = useMutation({
    mutationFn: ({ id, mspId }: { id: string; mspId: string | null }) =>
      api(`/tenants/${id}/msp`, { method: 'PATCH', body: JSON.stringify({ mspId }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenants'] }),
  });
  const setManagedServices = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/tenants/${id}/managed-services`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tenants'] });
      await refreshMe(); // the left nav shows Service Requests from the signed-in user's tenant list
    },
  });
  const setMonitoring = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/tenants/${id}/monitoring`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tenants'] });
      await refreshMe(); // the left nav shows Monitoring from the signed-in user's tenant list
    },
  });
  const setSandbox = useMutation({
    mutationFn: ({ id, sandbox, sandboxEmail }: { id: string; sandbox: boolean; sandboxEmail?: string | null }) =>
      api(`/tenants/${id}/sandbox`, { method: 'PATCH', body: JSON.stringify({ sandbox, sandboxEmail }) }),
    onSuccess: async () => {
      setSandboxErr(null);
      await qc.invalidateQueries({ queryKey: ['tenants'] });
      await refreshMe(); // the "Test customer" badge in the customer switcher
    },
    onError: (e) => setSandboxErr((e as Error).message),
  });
  const create = useMutation({
    mutationFn: async () => {
      const created = await api<Tenant>('/tenants', {
        method: 'POST',
        body: JSON.stringify({ name, slug, primaryDomain: domain || undefined }),
      });
      if (accentColor !== DEFAULT_ACCENT) {
        await api(`/tenants/${created.id}/branding`, { method: 'PATCH', body: JSON.stringify({ accentColor }) });
      }
      if (logoFile) await apiUpload(`/tenants/${created.id}/branding/logo`, logoFile);
      return created;
    },
    onSuccess: async (created) => {
      setName('');
      setSlug('');
      setDomain('');
      setAccentColor(DEFAULT_ACCENT);
      setLogoFile(null);
      setErr(null);
      qc.invalidateQueries({ queryKey: ['tenants'] });
      // Pull the new customer into the header switcher and select it.
      await refreshMe();
      if (created?.id) setActiveTenant(created.id);
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  return (
    <Page platform
      title="Customers"
      subtitle="Each customer gets an isolated database schema, provisioned automatically on creation."
    >
      <Card>
        <Text weight="semibold">New customer</Text>
        <div className={ls.flexWrapItemsEndGap12}>
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
          <Field label="Accent color">
            <input
              type="color"
              value={accentColor}
              onChange={(e) => setAccentColor(e.target.value)}
              className={ls.w40H32FilledPad0}
            />
          </Field>
          <Field label="Logo (optional)" hint="PNG or JPEG - WebP isn't supported by classic Outlook desktop">
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Button
            appearance="primary"
            disabled={!name || slug.length < 2 || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </div>
        {err && <DangerText>{err}</DangerText>}
      </Card>

      {can('tenant:delete') && (pendingDeletion.data?.length ?? 0) > 0 && (
        <Card>
          <Text weight="semibold">Deletion not finished</Text>
          <MutedText size={200}>
            These customers are hidden and nobody can open them, but part of their data is still stored. Finish the deletion to remove it.
          </MutedText>
          {pendingDeletion.data!.map((t) => (
            <div key={t.id} className={ls.pendingRow}>
              <Text>{t.name}</Text>
              <Button size="small" appearance="secondary" onClick={() => setDeleting({ id: t.id, name: t.name, resume: true })}>
                Finish deleting…
              </Button>
            </div>
          ))}
        </Card>
      )}

      <Card>
        <SearchBox
          size="small"
          placeholder="Search by name, slug or domain…"
          value={searchInput}
          onChange={(_, d) => setSearchInput(d.value)}
          className={ls.maxW320}
        />
        {list.isLoading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : list.isError ? (
          <LoadError message={(list.error as Error).message} />
        ) : (
          <DataTable size="small" minWidth={can('tenant:delete') ? 1120 : 940}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Slug</TableHeaderCell>
                <TableHeaderCell>Domain</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Branding</TableHeaderCell>
                <TableHeaderCell>Teams read-only</TableHeaderCell>
                <TableHeaderCell>Managed Services</TableHeaderCell>
                {featureOn('monitoring') && <TableHeaderCell>Monitoring</TableHeaderCell>}
                {featureOn('msp') && <TableHeaderCell>MSP</TableHeaderCell>}
                <TableHeaderCell>Test customer</TableHeaderCell>
                {can('tenant:delete') && <TableHeaderCell>Danger zone</TableHeaderCell>}
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
                    <div className={ls.flexItemsCenterGap8}>
                      {t.branding?.logo && (
                        <img
                          src={`/api/public/tenants/${t.id}/logo?v=${t.branding.logo.version}`}
                          alt=""
                          className={ls.blockWAutoH20}
                        />
                      )}
                      {can('tenant:update') ? (
                        <Button size="small" appearance="subtle" onClick={() => setBrandingFor(t)}>
                          Edit branding
                        </Button>
                      ) : (
                        t.branding && (
                          <MutedText size={200}>
                            Branded
                          </MutedText>
                        )
                      )}
                    </div>
                  </TableCell>
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
                  <TableCell>
                    {can('tenant:update') ? (
                      <Checkbox
                        checked={t.managed_services_enabled}
                        disabled={setManagedServices.isPending}
                        label={t.managed_services_enabled ? 'On' : 'Off'}
                        onChange={(_, d) => setManagedServices.mutate({ id: t.id, enabled: !!d.checked })}
                      />
                    ) : t.managed_services_enabled ? (
                      <Badge appearance="tint" color="success">
                        On
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  {featureOn('monitoring') && (
                    <TableCell>
                      {can('tenant:update') ? (
                        <Checkbox
                          checked={t.monitoring_enabled}
                          disabled={setMonitoring.isPending}
                          label={t.monitoring_enabled ? 'On' : 'Off'}
                          onChange={(_, d) => setMonitoring.mutate({ id: t.id, enabled: !!d.checked })}
                        />
                      ) : t.monitoring_enabled ? (
                        <Badge appearance="tint" color="success">
                          On
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  )}
                  {featureOn('msp') && (
                  <TableCell>
                    {can('tenant:update') ? (
                      <Select
                        size="small"
                        value={t.msp_id ?? ''}
                        disabled={setMsp.isPending}
                        onChange={(_, d) => setMsp.mutate({ id: t.id, mspId: d.value || null })}
                      >
                        <option value="">No MSP</option>
                        {(mspList.data ?? []).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      (mspList.data ?? []).find((m) => m.id === t.msp_id)?.name ?? '—'
                    )}
                  </TableCell>
                  )}
                  <TableCell>
                    {can('tenant:update') ? (
                      <div className={ls.gridGap4}>
                        <Checkbox
                          checked={t.sandbox}
                          disabled={setSandbox.isPending}
                          label={t.sandbox ? 'On' : 'Off'}
                          onChange={(_, d) => setSandbox.mutate({ id: t.id, sandbox: !!d.checked })}
                        />
                        {t.sandbox && (
                          <Input
                            key={t.sandbox_email ?? ''}
                            size="small"
                            type="email"
                            placeholder="Fallback address (optional)"
                            title="Where emails nobody triggered (reminders) go. Empty = they're not sent."
                            defaultValue={t.sandbox_email ?? ''}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v !== (t.sandbox_email ?? '')) setSandbox.mutate({ id: t.id, sandbox: true, sandboxEmail: v || null });
                            }}
                          />
                        )}
                      </div>
                    ) : t.sandbox ? (
                      <Badge appearance="tint" color="warning">
                        Test customer
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  {can('tenant:delete') && (
                    <TableCell className={ls.dangerZone}>
                      <Button size="small" appearance="subtle" icon={<DeleteRegular />} className={ls.dangerZone} onClick={() => setDeleting({ id: t.id, name: t.name })}>
                        Delete customer…
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
        <MutedText size={200}>
          When Teams read-only is on, the platform can never send a write cmdlet to that customer's
          live Microsoft Teams tenant - every deployment run is forced to dry-run, no matter what
          mode is requested. Discovery and validation (read-only) are unaffected.
        </MutedText>
        {sandboxErr && <DangerText>{sandboxErr}</DangerText>}
        {can('tenant:delete') && (
          <MutedText size={200}>
            "Delete customer…" removes a customer and all of its data for good. You are asked to type the customer's name and a code from your
            authenticator app first. It is refused while a deployment or a Discovery run is in progress. Backups taken earlier still hold the data.
          </MutedText>
        )}
        <MutedText size={200}>
          A test customer never emails its real recipients: every email for it goes to the person who
          triggered it, with the subject starting "[TEST - would have gone to ...]". Emails nobody
          triggered (reminders) go to the fallback address, or aren't sent if it's empty.
        </MutedText>
      </Card>

      {brandingFor && (
        <BrandingDialog
          tenant={brandingFor}
          onClose={() => setBrandingFor(null)}
          onSaved={async () => {
            setBrandingFor(null);
            qc.invalidateQueries({ queryKey: ['tenants'] });
            await refreshMe(); // so AppShell picks up the change immediately if this is the active tenant
          }}
        />
      )}

      {deleting && <DeleteCustomerDialog tenant={deleting} resume={deleting.resume} onClose={() => setDeleting(null)} />}

      {allTenants.data && allTenants.data.length > 0 && <CustomerMembers tenants={allTenants.data} />}
    </Page>
  );
}

/* ------------------------------- branding ------------------------------- */

function BrandingDialog({
  tenant,
  onClose,
  onSaved,
}: {
  tenant: Tenant;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ls = useLocalStyles();
  const [accentColor, setAccentColor] = useState(tenant.branding?.accentColor ?? DEFAULT_ACCENT);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoRemoved, setLogoRemoved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await api(`/tenants/${tenant.id}/branding`, { method: 'PATCH', body: JSON.stringify({ accentColor }) });
      if (logoFile) await apiUpload(`/tenants/${tenant.id}/branding/logo`, logoFile);
      else if (logoRemoved) await api(`/tenants/${tenant.id}/branding/logo`, { method: 'DELETE' });
    },
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  const previewUrl = logoRemoved
    ? null
    : logoFile
      ? URL.createObjectURL(logoFile)
      : tenant.branding?.logo
        ? `/api/public/tenants/${tenant.id}/logo?v=${tenant.branding.logo.version}`
        : null;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Branding — {tenant.name}</DialogTitle>
          <DialogContent>
            <div className={ls.gridGap12MinW380}>
              <div className={ls.flexItemsCenterGap12}>
                {previewUrl ? (
                  <img src={previewUrl} alt="" className={ls.wAutoH40} />
                ) : (
                  <Wordmark size={18} />
                )}
                <MutedText size={200}>
                  {previewUrl ? 'Current logo' : 'No logo set - default Voxshift mark shown everywhere'}
                </MutedText>
              </div>
              <Field label="Replace logo" hint="PNG or JPEG - WebP isn't supported by classic Outlook desktop">
                <div className={ls.flexItemsCenterGap8}>
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    onChange={(e) => {
                      setLogoFile(e.target.files?.[0] ?? null);
                      setLogoRemoved(false);
                    }}
                  />
                  {previewUrl && (
                    <Button
                      size="small"
                      appearance="subtle"
                      onClick={() => {
                        setLogoFile(null);
                        setLogoRemoved(true);
                      }}
                    >
                      Remove logo
                    </Button>
                  )}
                </div>
              </Field>
              <Field label="Accent color">
                <input
                  type="color"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className={ls.w40H32FilledPad0}
                />
              </Field>
              {err && <DangerText>{err}</DangerText>}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onClose}>
                Cancel
              </Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* --------------------------- members + site scope --------------------------- */

function CustomerMembers({ tenants }: { tenants: Tenant[] }) {
  const ls = useLocalStyles();
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
      <div className={ls.flexWrapItemsEndGap122}>
        <Text weight="semibold">Members &amp; site access</Text>
        <Field label="Customer">
          <Dropdown
            value={tenants.find((t) => t.id === sel)?.name ?? ''}
            selectedOptions={[sel]}
            onOptionSelect={(_, d) => d.optionValue && setSel(d.optionValue)}
            className={ls.minW220}
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
                      <div className={ls.flexWrapGap4}>
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

      <div className={ls.flexWrapItemsEndGap8}>
        <Field label="Add an existing customer user">
          <Dropdown
            placeholder={eligible.length ? 'Select a user…' : 'No unassigned customer users'}
            selectedOptions={addUserId ? [addUserId] : []}
            value={eligible.find((u) => u.id === addUserId)?.email ?? ''}
            onOptionSelect={(_, d) => setAddUserId(d.optionValue ?? '')}
            className={ls.minW260}
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
      {err && <DangerText>{err}</DangerText>}

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
  const ls = useLocalStyles();
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
            <div className={ls.gridGap12MinW380}>
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
              {err && <DangerText>{err}</DangerText>}
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
