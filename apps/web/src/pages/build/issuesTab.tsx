import { useMemo, useState, type CSSProperties } from 'react';
import { Badge, Button, Checkbox, Text, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowClockwiseRegular, ArrowDownloadRegular, ErrorCircleRegular, InfoRegular, MailRegular, WarningRegular } from '@fluentui/react-icons';
import { issuesCsv, licenceRequestCsv, licenceRequestUpns, type BuildIssueRow, type ValidationSeverity } from '@tvmf/shared';
import { DataTable } from '../../components/DataTable';
import { LoadError } from '../../components/records';
import { downloadText } from '../../lib/download';
import { EmailIssuesDialog } from './emailIssuesDialog';
import { EmptyState } from '../../components/states';
import { TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components';
import type { BuildTab } from './buildShared';

const useStyles = makeStyles({
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '8px' },
  grow: { flexGrow: 1 },
  muted: { color: tokens.colorNeutralForeground3 },
  person: { display: 'flex', flexDirection: 'column' },
});

/** The table keeps every cell on one line with an ellipsis; these columns hold sentences, so they wrap onto as many lines as they need. */
const WRAP: CSSProperties = { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip', overflowWrap: 'anywhere', maxWidth: 'none' };

const SEVERITY: Record<ValidationSeverity, { label: string; plural: string; color: 'danger' | 'warning' | 'informative'; icon: JSX.Element; hint: string }> = {
  blocking: {
    label: 'Blocks deployment',
    plural: 'Block deployment',
    color: 'danger',
    icon: <ErrorCircleRegular />,
    hint: 'A deployment skips this row until it is fixed, and lists it under "Not deployed" in the change document.',
  },
  warning: { label: 'Warning', plural: 'Warnings', color: 'warning', icon: <WarningRegular />, hint: 'The row still deploys, but is likely to cause trouble.' },
  // Only a decided number change is "info": a record of the accept or reject, kept so it can be undone. It is not a category to filter by.
  info: { label: 'Decided', plural: 'Decided', color: 'informative', icon: <InfoRegular />, hint: 'You accepted or rejected this number change. Undo to be asked again.' },
};
/** The categories the filter buttons offer. What deployment will change is not a validation issue; the Deployment module shows it. */
const FILTERS: ValidationSeverity[] = ['blocking', 'warning'];

const SHEET_LABEL: Record<BuildIssueRow['sheet'], string> = { users: 'Users', caps: 'Common area phones', 'resource-accounts': 'Resource accounts' };

/** Every validation issue on the site in one list, most serious first. */
export function ValidationIssuesTab({
  issues,
  loading,
  error,
  onRefresh,
  onOpen,
  canDecide,
  onDecide,
  deciding,
  fileBase,
  base,
  siteId,
  canEmail,
}: {
  /** the Design & Build API base, and the site, for emailing issues to its contacts */
  base: string;
  siteId: string;
  /** may email issues to the site contacts */
  canEmail: boolean;
  /** the site, for the names of the exported files, e.g. its site code */
  fileBase: string;
  issues: BuildIssueRow[] | undefined;
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
  onOpen: (tab: BuildTab) => void;
  /** may accept or reject a number change */
  canDecide: boolean;
  onDecide: (row: BuildIssueRow, decision: 'accepted' | 'rejected' | 'reset') => void;
  deciding: boolean;
}) {
  const s = useStyles();
  const [filter, setFilter] = useState<ValidationSeverity | 'all'>('all');
  const counts = useMemo(() => {
    const c: Record<ValidationSeverity, number> = { blocking: 0, warning: 0, info: 0 };
    for (const i of issues ?? []) c[i.issue.severity] += 1;
    return c;
  }, [issues]);
  const shown = (issues ?? []).filter((i) => filter === 'all' || i.issue.severity === filter);
  // Ticked issues, by what identifies them. A decided number change is a record, not something to resolve, so it can't be ticked.
  const idOf = (i: BuildIssueRow) => `${i.sheet}|${i.rowId}|${i.issue.code}|${i.issue.detail}`;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [emailing, setEmailing] = useState(false);
  const pickable = shown.filter((i) => i.issue.severity !== 'info');
  const pickedIssues = (issues ?? []).filter((i) => picked.has(idOf(i)) && i.issue.severity !== 'info');
  const allShownPicked = pickable.length > 0 && pickable.every((i) => picked.has(idOf(i)));
  const setMany = (list: BuildIssueRow[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const i of list) {
        if (on) next.add(idOf(i));
        else next.delete(idOf(i));
      }
      return next;
    });
  const needLicence = licenceRequestUpns(issues ?? []).length;
  const stamp = new Date().toISOString().slice(0, 10);
  const safeBase = fileBase.replace(/[^A-Za-z0-9._-]+/g, '-') || 'site';
  const people = new Set((issues ?? []).map((i) => `${i.sheet}:${i.rowId}`)).size;

  if (error) return <LoadError message={(error as Error).message} />;
  return (
    <>
      <div className={s.bar}>
        <Button size="small" appearance={filter === 'all' ? 'primary' : 'secondary'} onClick={() => setFilter('all')}>
          All ({issues?.length ?? 0})
        </Button>
        {FILTERS.map((k) => (
          <Button key={k} size="small" appearance={filter === k ? 'primary' : 'secondary'} icon={SEVERITY[k].icon} title={SEVERITY[k].hint} onClick={() => setFilter(k)}>
            {SEVERITY[k].plural} ({counts[k]})
          </Button>
        ))}
        <span className={s.grow} />
        <Text size={200} className={s.muted}>
          {people} row{people === 1 ? '' : 's'} affected
        </Text>
        {canEmail && (
          <Button
            size="small"
            appearance="primary"
            icon={<MailRegular />}
            disabled={pickedIssues.length === 0}
            title={pickedIssues.length === 0 ? 'Tick the issues to send, then email them to the site contacts.' : 'Email the ticked issues to the site contacts'}
            onClick={() => setEmailing(true)}
          >
            Email site contacts{pickedIssues.length ? ` (${pickedIssues.length})` : ''}
          </Button>
        )}
        <Button
          size="small"
          icon={<ArrowDownloadRegular />}
          disabled={!issues || issues.length === 0}
          title="Every issue on this site as a spreadsheet (CSV), whatever the filter."
          onClick={() => downloadText(`validation-issues-${safeBase}-${stamp}.csv`, issuesCsv(issues ?? []), { bom: true })}
        >
          Export all issues
        </Button>
        <Button
          size="small"
          icon={<ArrowDownloadRegular />}
          disabled={needLicence === 0}
          title={needLicence === 0 ? 'No account on this site is missing a Teams Phone licence.' : `${needLicence} account${needLicence === 1 ? '' : 's'} with no phone licence: a CSV of their UPNs under the title "Member object ID or user principal name [memberObjectIdOrUpn] Required".`}
          onClick={() => downloadText(`licence-request-${safeBase}-${stamp}.csv`, licenceRequestCsv(issues ?? []))}
        >
          Export licence request{needLicence ? ` (${needLicence})` : ''}
        </Button>
        <Button size="small" icon={<ArrowClockwiseRegular />} disabled={loading} onClick={onRefresh}>
          {loading ? 'Checking…' : 'Refresh'}
        </Button>
      </div>
      {issues && issues.length === 0 ? (
        <EmptyState title="No validation issues" hint="Every user, common area phone and resource account on this site matches the tenant. Use Validate against tenant to check again." />
      ) : (
        <DataTable size="small" minWidth={1100} fitScreen>
          <TableHeader>
            <TableRow>
              {canEmail && (
                <TableHeaderCell style={{ width: 40 }}>
                  <Checkbox aria-label="Tick every issue shown" checked={allShownPicked} disabled={pickable.length === 0} onChange={(_, d) => setMany(pickable, !!d.checked)} />
                </TableHeaderCell>
              )}
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
                  {canEmail && (
                    <TableCell>
                      <Checkbox
                        aria-label={`Tick ${i.displayName ?? i.upn}: ${i.issue.label}`}
                        checked={picked.has(idOf(i))}
                        disabled={i.issue.severity === 'info'}
                        onChange={(_, d) => setMany([i], !!d.checked)}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <Badge appearance="tint" color={sev.color} icon={sev.icon} title={sev.hint}>
                      {sev.label}
                    </Badge>
                  </TableCell>
                  <TableCell>{SHEET_LABEL[i.sheet]}</TableCell>
                  <TableCell style={{ ...WRAP, minWidth: 180 }}>
                    <div className={s.person}>
                      <span>{i.displayName ?? i.upn}</span>
                      {i.displayName && <Text size={200} className={s.muted}>{i.upn}</Text>}
                    </div>
                  </TableCell>
                  <TableCell style={{ ...WRAP, minWidth: 160 }}>{i.issue.label}</TableCell>
                  <TableCell style={{ ...WRAP, minWidth: 320 }}>{i.issue.detail}</TableCell>
                  <TableCell>
                    {i.issue.code === 'number_change' && canDecide && i.sheet !== 'resource-accounts' && (
                      i.issue.decision === 'pending' ? (
                        <>
                          <Button size="small" appearance="primary" disabled={deciding} onClick={() => onDecide(i, 'accepted')} title="Go ahead with the designed number">
                            Accept
                          </Button>{' '}
                          <Button size="small" disabled={deciding} onClick={() => onDecide(i, 'rejected')} title="Record that this change is not wanted. The design is not changed: edit the row's number if it should be different.">
                            Reject
                          </Button>{' '}
                        </>
                      ) : (
                        <>
                          <Button size="small" appearance="subtle" disabled={deciding} onClick={() => onDecide(i, 'reset')} title="Ask again">
                            Undo
                          </Button>{' '}
                        </>
                      )
                    )}
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
      {emailing && (
        <EmailIssuesDialog
          base={base}
          siteId={siteId}
          sitecode={fileBase}
          issues={pickedIssues}
          onClose={() => setEmailing(false)}
          onSent={() => setPicked(new Set())}
        />
      )}
    </>
  );
}
