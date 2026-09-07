import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Dropdown,
  Field,
  Input,
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
import { ROLES, type Role } from '@tvmf/shared';
import { api } from '../../api';
import { Page } from '../../components/Page';
import { LoadError } from '../DataCollection';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  totp_enrolled: boolean;
}
interface TenantRow {
  id: string;
  name: string;
}

export function AdminUsers() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('ENGINEER');
  const [password, setPassword] = useState('');
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/users') });
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api<TenantRow[]>('/tenants') });

  const create = useMutation({
    mutationFn: () =>
      api('/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          displayName,
          role,
          password,
          tenantIds: role === 'SUPER_ADMIN' ? undefined : tenantIds,
        }),
      }),
    onSuccess: () => {
      setEmail('');
      setDisplayName('');
      setPassword('');
      setTenantIds([]);
      setErr(null);
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Failed'),
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'disable' | 'enable' | 'reset-mfa' }) =>
      api(`/users/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <Page title="Users" subtitle="Platform staff and customer users.">
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
          <Field label="Temp password" hint="min 12 chars">
            <Input type="text" value={password} onChange={(_, d) => setPassword(d.value)} />
          </Field>
          {role !== 'SUPER_ADMIN' && (
            <Field label={role === 'CUSTOMER' ? 'Customer (exactly one)' : 'Assigned customers'}>
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
          <Button
            appearance="primary"
            disabled={!email || !displayName || password.length < 12 || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </div>
        {err && <Text style={{ color: '#b10e1c' }}>{err}</Text>}
      </Card>

      <Card>
        {users.isLoading ? (
          <Spinner size="tiny" />
        ) : users.isError ? (
          <LoadError message={(users.error as Error).message} />
        ) : (
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Email</TableHeaderCell>
                <TableHeaderCell>Role</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>MFA</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data!.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.display_name}</TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>{u.role}</TableCell>
                  <TableCell>{u.status}</TableCell>
                  <TableCell>{u.totp_enrolled ? 'enrolled' : '—'}</TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', gap: 6 }}>
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
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
