import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Spinner,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from '@fluentui/react-components';
import { ArrowRightRegular } from '@fluentui/react-icons';
import type { BuildSiteRollup } from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant, useRecordStyles } from '../components/records';

const DEPLOY_COLOR: Record<string, 'informative' | 'warning' | 'success' | 'danger'> = {
  queued: 'informative',
  running: 'informative',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warning',
};

export function Build() {
  const s = useRecordStyles();
  const navigate = useNavigate();
  const { activeTenantId } = useAuth();

  const q = useQuery({
    queryKey: ['build-summary', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<BuildSiteRollup[]>(`/t/${activeTenantId}/build/summary`),
  });

  if (!activeTenantId) return <NoTenant />;
  if (q.isLoading) return <Spinner label="Loading Design & Build…" />;
  if (q.isError) return <LoadError message={(q.error as Error).message} />;

  const sites = q.data ?? [];
  const open = (id: string) => navigate(`/build/sites/${id}`);

  return (
    <Page
      title="Design & Build"
      subtitle="Pick a site to design its users, common area phones and resource accounts — target policies, numbers and voicemail, validated live against the tenant. Replaces the build workbook."
    >
      <Card className={s.card}>
        <div className={s.cardHead}>
          <Text weight="semibold" size={400}>
            Sites <span className={s.muted}>({sites.length})</span>
          </Text>
        </div>

        {sites.length === 0 ? (
          <Text size={200} className={s.muted}>
            No sites yet — add one in Data Collection first.
          </Text>
        ) : (
          <DataTable size="small" minWidth={860}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Sitecode</TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Users</TableHeaderCell>
                <TableHeaderCell>CAPs</TableHeaderCell>
                <TableHeaderCell>Res. accts</TableHeaderCell>
                <TableHeaderCell>Validation</TableHeaderCell>
                <TableHeaderCell>Last deployment</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.sitecode}</TableCell>
                  <TableCell>{r.name || '—'}</TableCell>
                  <TableCell>{r.counts.users}</TableCell>
                  <TableCell>{r.counts.caps}</TableCell>
                  <TableCell>{r.counts.resourceAccounts}</TableCell>
                  <TableCell>
                    {r.validationIssues > 0 ? (
                      <Badge appearance="tint" color="warning">
                        {r.validationIssues} issue{r.validationIssues === 1 ? '' : 's'}
                      </Badge>
                    ) : (
                      <Badge appearance="tint" color="success">
                        clean
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.lastDeployment ? (
                      <Badge appearance="tint" color={DEPLOY_COLOR[r.lastDeployment.status] ?? 'informative'}>
                        {r.lastDeployment.mode === 'dry_run' ? 'dry run' : 'deployed'} · {r.lastDeployment.status}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <Button size="small" appearance="subtle" icon={<ArrowRightRegular />} onClick={() => open(r.id)}>
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>
    </Page>
  );
}
