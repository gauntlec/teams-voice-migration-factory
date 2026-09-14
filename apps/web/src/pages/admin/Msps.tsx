import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from '@fluentui/react-components';
import type { Branding } from '@tvmf/shared';
import { api, apiUpload } from '../../api';
import { useAuth } from '../../auth';
import { DataTable } from '../../components/DataTable';
import { Page } from '../../components/Page';
import { Wordmark } from '../../components/Logo';
import { LoadError } from '../DataCollection';

const DEFAULT_ACCENT = '#4657D2';

interface Msp {
  id: string;
  name: string;
  slug: string;
  domains: string[];
  branding: Branding | null;
  created_at: string;
}

/** Splits a comma/newline-separated list of domains into a clean array - the server also
 *  lowercases/trims/dedupes, this is just to show the admin a sane preview before saving. */
function splitDomains(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

export function AdminMsps() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [domainsRaw, setDomainsRaw] = useState('');
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [brandingFor, setBrandingFor] = useState<Msp | null>(null);

  const list = useQuery({ queryKey: ['msps'], queryFn: () => api<Msp[]>('/msps') });
  const create = useMutation({
    mutationFn: async () => {
      const created = await api<Msp>('/msps', {
        method: 'POST',
        body: JSON.stringify({ name, slug, domains: splitDomains(domainsRaw) }),
      });
      if (accentColor !== DEFAULT_ACCENT) {
        await api(`/msps/${created.id}/branding`, { method: 'PATCH', body: JSON.stringify({ accentColor }) });
      }
      if (logoFile) await apiUpload(`/msps/${created.id}/branding/logo`, logoFile);
      return created;
    },
    onSuccess: () => {
      setName('');
      setSlug('');
      setDomainsRaw('');
      setAccentColor(DEFAULT_ACCENT);
      setLogoFile(null);
      setErr(null);
      qc.invalidateQueries({ queryKey: ['msps'] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  return (
    <Page
      title="MSPs"
      subtitle="Managed Service Providers - engineers and project managers see their MSP's branding in the app chrome, resolved by their account's email domain."
    >
      <Card>
        <Text weight="semibold">New MSP</Text>
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
          <Field label="Domains" hint="comma or newline separated, e.g. contoso.com, intl.contoso.com">
            <Input value={domainsRaw} onChange={(_, d) => setDomainsRaw(d.value)} placeholder="contoso.com" />
          </Field>
          <Field label="Accent color">
            <input
              type="color"
              value={accentColor}
              onChange={(e) => setAccentColor(e.target.value)}
              style={{ width: 40, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
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
        {err && <Text style={{ color: '#b10e1c' }}>{err}</Text>}
      </Card>

      <Card>
        {list.isLoading ? (
          <Spinner size="tiny" />
        ) : list.isError ? (
          <LoadError message={(list.error as Error).message} />
        ) : (
          <DataTable size="small" minWidth={700}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Slug</TableHeaderCell>
                <TableHeaderCell>Domains</TableHeaderCell>
                <TableHeaderCell>Branding</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.name}</TableCell>
                  <TableCell>{m.slug}</TableCell>
                  <TableCell>{m.domains.length ? m.domains.join(', ') : '—'}</TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {m.branding?.logo && (
                        <img
                          src={`/api/public/msps/${m.id}/logo?v=${m.branding.logo.version}`}
                          alt=""
                          style={{ height: 20, width: 'auto', display: 'block' }}
                        />
                      )}
                      {can('msp:update') ? (
                        <Button size="small" appearance="subtle" onClick={() => setBrandingFor(m)}>
                          Edit branding
                        </Button>
                      ) : (
                        m.branding && (
                          <Text size={200} style={{ color: '#616161' }}>
                            Branded
                          </Text>
                        )
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>

      {brandingFor && (
        <BrandingDialog
          msp={brandingFor}
          onClose={() => setBrandingFor(null)}
          onSaved={() => {
            setBrandingFor(null);
            qc.invalidateQueries({ queryKey: ['msps'] });
          }}
        />
      )}
    </Page>
  );
}

/* ------------------------------- branding ------------------------------- */

function BrandingDialog({ msp, onClose, onSaved }: { msp: Msp; onClose: () => void; onSaved: () => void }) {
  const [accentColor, setAccentColor] = useState(msp.branding?.accentColor ?? DEFAULT_ACCENT);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoRemoved, setLogoRemoved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await api(`/msps/${msp.id}/branding`, { method: 'PATCH', body: JSON.stringify({ accentColor }) });
      if (logoFile) await apiUpload(`/msps/${msp.id}/branding/logo`, logoFile);
      else if (logoRemoved) await api(`/msps/${msp.id}/branding/logo`, { method: 'DELETE' });
    },
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  const previewUrl = logoRemoved
    ? null
    : logoFile
      ? URL.createObjectURL(logoFile)
      : msp.branding?.logo
        ? `/api/public/msps/${msp.id}/logo?v=${msp.branding.logo.version}`
        : null;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Branding — {msp.name}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'grid', gap: 12, minWidth: 380 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {previewUrl ? (
                  <img src={previewUrl} alt="" style={{ height: 40, width: 'auto' }} />
                ) : (
                  <Wordmark size={18} />
                )}
                <Text size={200} style={{ color: '#616161' }}>
                  {previewUrl ? 'Current logo' : 'No logo set - default Voxshift mark shown everywhere'}
                </Text>
              </div>
              <Field label="Replace logo" hint="PNG or JPEG - WebP isn't supported by classic Outlook desktop">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                  style={{ width: 40, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                />
              </Field>
              {err && <Text style={{ color: '#b10e1c' }}>{err}</Text>}
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
