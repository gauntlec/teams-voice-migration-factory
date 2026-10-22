import { useMemo, useState } from 'react';
import { Badge, Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowClockwiseRegular, ErrorCircleRegular, InfoRegular, WarningRegular } from '@fluentui/react-icons';
import type { BuildIssueRow, ValidationSeverity } from '@tvmf/shared';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { EmptyState } from '../../components/states';
import { TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components';
import type { BuildTab } from './buildShared';

const useStyles = makeStyles({
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '8px' },
  grow: { flexGrow: 1 },
  muted: { color: tokens.colorNeutralForeground3 },
  wrap: { whiteSpace: 'normal' },
  person: { display: 'flex', flexDirection: 'column' },
});

const SEVERITY: Record<ValidationSeverity, { label: string; plural: string; color: 'danger' | 'warning' | 'informative'; icon: JSX.Element; hint: string }> = {
  blocking: {
    label: 'Blocks deployment',
    plural: 'Block deployment',
    color: 'danger',
    icon: <ErrorCircleRegular />,
    hint: 'A deployment skips this row until it is fixed, and lists it under "Not deployed" in the change document.',
  },
  warning: { label: 'Warning', plural: 'Warnings', color: 'warning', icon: <WarningRegular />, hint: 'The row still deploys, but is likely to cause trouble.' },
  info: { label: 'Will change', plural: 'Will change', color: 'informative', icon: <InfoRegular />, hint: 'Nothing is wrong: deployment will change a setting, or a name is stale.' },
};

const SHEET_LABEL: Record<BuildIssueRow['sheet'], string> = { users: 'Users', caps: 'Common area phones', 'resource-accounts': 'Resource accounts' };

/** Every validation issue on the site in one list, most serious first. */
export function ValidationIssuesTab({
  issues,
  loading,
  error,
  onRefresh,
  onOpen,
}: {
  issues: BuildIssueRow[] | undefined;
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
  onOpen: (tab: BuildTab) => void;
}) {
  const s = useStyles();
  const [filter, setFilter] = useState<ValidationSeverity | 'all'>('all');
  const counts = useMemo(() => {
    const c: Record<ValidationSeverity, number> = { blocking: 0, warning: 0, info: 0 };
    for (const i of issues ?? []) c[i.issue.severity] += 1;
    return c;
  }, [issues]);
  const shown = (issues ?? []).filter((i) => filter === 'all' || i.issue.severity === filter);
  const people = new Set((issues ?? []).map((i) => `${i.sheet}:${i.rowId}`)).size;

  if (error) return <LoadError message={(error as Error).message} />;
  return (
    <>
      <div className={s.bar}>
        <Button size="small" appearance={filter === 'all' ? 'primary' : 'secondary'} onClick={() => setFilter('all')}>
          All ({issues?.length ?? 0})
        </Button>
        {(Object.keys(SEVERITY) as ValidationSeverity[]).map((k) => (
          <Button key={k} size="small" appearance={filter === k ? 'primary' : 'secondary'} icon={SEVERITY[k].icon} title={SEVERITY[k].hint} onClick={() => setFilter(k)}>
            {SEVERITY[k].plural} ({counts[k]})
          </Button>
        ))}
        <span className={s.grow} />
        <Text size={200} className={s.muted}>
          {people} row{people === 1 ? '' : 's'} affected
        </Text>
        <Button size="small" icon={<ArrowClockwiseRegular />} disabled={loading} onClick={onRefresh}>
          {loading ? 'Checking…' : 'Refresh'}
        </Button>
      </div>
      {issues && issues.length === 0 ? (
        <EmptyState title="No validation issues" hint="Every user, common area phone and resource account on this site matches the tenant. Use Validate against tenant to check again." />
      ) : (
        <DataTable size="small" minWidth={900} fitScreen>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Severity</TableHeaderCell>
              <TableHeaderCell>Sheet</TableHeaderCell>
              <TableHeaderCell>Name / UPN</TableHeaderCell>
              <TableHeaderCell>Issue</TableHeaderCell>
              <TableHeaderCell>Detail</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((i, n) => {
              const sev = SEVERITY[i.issue.severity];
              return (
                <TableRow key={`${i.sheet}:${i.rowId}:${i.issue.code}:${n}`}>
                  <TableCell>
                    <Badge appearance="tint" color={sev.color} icon={sev.icon} title={sev.hint}>
                      {sev.label}
                    </Badge>
                  </TableCell>
                  <TableCell>{SHEET_LABEL[i.sheet]}</TableCell>
                  <TableCell>
                    <div className={s.person}>
                      <span>{i.displayName ?? i.upn}</span>
                      {i.displayName && <Text size={200} className={s.muted}>{i.upn}</Text>}
                    </div>
                  </TableCell>
                  <TableCell>{i.issue.label}</TableCell>
                  <TableCell className={s.wrap}>{i.issue.detail}</TableCell>
                  <TableCell>
                    <Button size="small" appearance="subtle" onClick={() => onOpen(i.sheet)}>
                      Open {SHEET_LABEL[i.sheet].toLowerCase()}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </DataTable>
      )}
    </>
  );
}
