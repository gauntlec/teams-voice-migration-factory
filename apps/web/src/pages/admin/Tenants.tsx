import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Field,
  Input,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from '@fluentui/react-components';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Page } from '../../components/Page';
import { LoadError } from '../DataCollection';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  primary_domain: string | null;
  status: string;
  created_at: string;
}

export function AdminTenants() {
  const qc = useQueryClient();
  const { refreshMe, setActiveTenant } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [domain, setDomain] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['tenants'], queryFn: () => api<Tenant[]>('/tenants') });
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
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Slug</TableHeaderCell>
                <TableHeaderCell>Domain</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{t.name}</TableCell>
                  <TableCell>{t.slug}</TableCell>
                  <TableCell>{t.primary_domain ?? '—'}</TableCell>
                  <TableCell>{t.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
