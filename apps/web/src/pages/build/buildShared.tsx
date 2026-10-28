import { Badge, Tab , makeStyles } from '@fluentui/react-components';
import { CheckmarkCircleRegular, WarningRegular } from '@fluentui/react-icons';
import { AA_SUPPORTED_LANGUAGES, AA_TIME_ZONES, VOICEMAIL_PROMPT_LANGUAGES, validationIssues, type BuildRowValidation, type CallDelegate, type CallForwardingSettings, type PickupGroupSettings } from '@tvmf/shared';
import { type Choice, type ColumnDef, type Row } from '../../components/records';

const useLocalStyles = makeStyles({
  ml6: { marginLeft: '6px' },
});


/** Last 10 significant digits, for loose number matching (same rule Data Collection uses). */
export const numKey = (v: string | null | undefined): string => String(v ?? '').replace(/\D/g, '').slice(-10);

export const VOICEMAIL_LANGUAGE_CHOICES: Choice[] = VOICEMAIL_PROMPT_LANGUAGES.map((l) => ({
  value: l.code,
  label: `${l.label} (${l.code})`,
}));

/** Every language New-CsAutoAttendant/Set-CsAutoAttendant -LanguageId accepts - see AA_SUPPORTED_LANGUAGES. */
export const AA_LANGUAGE_CHOICES: Choice[] = AA_SUPPORTED_LANGUAGES.map((l) => ({
  value: l.code,
  label: l.speechInput ? `${l.label} (${l.code})` : `${l.label} (${l.code}, no voice input)`,
}));

/** Every Windows time zone ID New-CsAutoAttendant/Set-CsAutoAttendant -TimeZoneId accepts - see AA_TIME_ZONES. */
export const AA_TIME_ZONE_CHOICES: Choice[] = AA_TIME_ZONES.map((z) => ({
  value: z.id,
  label: `${z.label} (${z.id})`,
}));

/** Small live-vs-target badge - the replacement for the workbook's `G-*` columns. */
export function ValidationBadge({ v }: { v: BuildRowValidation | null }) {
  if (!v) return <>—</>;
  if (!v.existsInTenant) {
    return (
      <Badge
        appearance="tint"
        color="danger"
        icon={<WarningRegular />}
        title="Not found in the synced tenant data. The account may not exist, or a sync may have left it out: syncs skip disabled accounts and accounts without a Teams licence unless those options are ticked. Validate checks missing users live when a session is connected."
      >
        not in tenant
      </Badge>
    );
  }
  const list = validationIssues(v);
  const issues = list.length;
  // Renames aren't a real issue - deployment always resolves the live name
  // via policy_ids regardless - but still worth surfacing so the stale
  // display text next to it isn't mistaken for what will actually deploy.
  if (issues === 0) {
    const renameTitle = v.renamedPolicies.map((p) => `${p.label}: policy was renamed to "${p.liveName}" - refresh to sync`).join('\n');
    return v.renamedPolicies.length ? (
      <Badge appearance="tint" color="informative" title={renameTitle}>
        {v.renamedPolicies.length} renamed
      </Badge>
    ) : (
      <Badge appearance="tint" color="success" icon={<CheckmarkCircleRegular />}>
        matches
      </Badge>
    );
  }
  const title = list.map((i) => i.detail).join('\n');
  return (
    <Badge appearance="tint" color="warning" icon={<WarningRegular />} title={title}>
      {issues} issue{issues === 1 ? '' : 's'}
    </Badge>
  );
}

/** Short label for the "Calling settings" button - what's actually designed for this row, at a glance. */
export function callingSettingsSummary(r: Row): string {
  const cf = r.call_forwarding as CallForwardingSettings | null;
  const pg = r.pickup_group as PickupGroupSettings | null;
  const delegates = Array.isArray(r.delegates) ? (r.delegates as CallDelegate[]) : [];
  const bits: string[] = [];
  if (cf?.forwarding?.enabled) bits.push('Forwarding');
  if (cf?.unanswered?.enabled) bits.push('Unanswered');
  if (cf?.busyOnBusy) bits.push('Busy on busy');
  if (pg?.targets?.length) bits.push('Pickup group');
  if (delegates.length) bits.push(`${delegates.length} delegate${delegates.length === 1 ? '' : 's'}`);
  return bits.length ? bits.join(', ') : 'Calling settings…';
}

export const BUILD_TABS = ['users', 'caps', 'resource-accounts', 'shared-calling-policies', 'call-queues', 'auto-attendants', 'issues'] as const;

export type BuildTab = (typeof BUILD_TABS)[number];

/**
 * Set when the workspace is embedded in a service request's Design tab: the
 * request's site, only the rows designed for it (new rows are linked to it -
 * see setDesigningServiceRequest), no site-wide actions, and read-only unless
 * the request is Planned.
 */
export interface BuildEmbedding {
  siteId: string;
  requestId: string;
  reference: string;
  editable: boolean;
  /** Tab to open on, e.g. 'call-queues' for a call queue request. */
  tab?: BuildTab;
  /** Called after any row is added, changed or deleted here. */
  onChanged?: () => void;
}

/** The SR-0042 tags on a row designed for a service request. */
function SrTags({ refs }: { refs: unknown }) {
  const ls = useLocalStyles();
  if (!Array.isArray(refs) || refs.length === 0) return null;
  return (
    <>
      {(refs as string[]).map((ref) => (
        <Badge key={ref} size="small" appearance="tint" color="brand" className={ls.ml6} title={`Designed for service request ${ref}`}>
          {ref}
        </Badge>
      ))}
    </>
  );
}

/** Adds the row's service request tags after a column's own content (the row's first column). */
export function withSrTags(col: ColumnDef): ColumnDef {
  return {
    ...col,
    render: (r) => (
      <>
        {col.render ? col.render(r) : ((r[col.key] as string) ?? '—') || '—'}
        <SrTags refs={r.service_requests} />
      </>
    ),
  };
}
