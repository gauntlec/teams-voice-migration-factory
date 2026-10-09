import { useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  Field,
  Input,
  Radio,
  RadioGroup,
  Link,
  Select,
  Spinner,
  Tab,
  TabList,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import { ArrowLeftRegular, CheckmarkRegular, ChevronRightRegular, WarningRegular } from '@fluentui/react-icons';
import {
  SR_BUILD_KIND,
  SR_BUILD_KIND_LABELS,
  SR_ITEM_KIND_LABELS,
  SR_NOTE_REQUIRED,
  SR_REOPEN_DAYS,
  SR_STATUS_LABELS,
  SR_TYPE_DEFS,
  canMoveSr,
  isSrChangeType,
  nextSrStatus,
  srCanReopen,
  srMoveKind,
  srStatusLabel,
  srDesignEditable,
  srDetailLines,
  srHasDesign,
  type DeploymentPreviewRow,
  type SrBuildDraftResult,
  type SrBuildKind,
  type SrBuildLink,
  type SrClock,
  type SrDeploymentRun,
  type SrDesignSummary,
  type SrItem,
  type SrStatus,
} from '@tvmf/shared';
import { api, setDesigningServiceRequest } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from '../components/records';
import { BuildSiteWorkspace, type BuildTab } from './BuildSiteWorkspace';
import { SlaBadge } from '../components/SrTarget';
import { hoursText } from './ServiceRequestAdmin';
import {
  PRIORITY_LABEL,
  STATUS_COLOR,
  day,
  errorText,
  useSrStyles,
  when,
  type RequestBuildInfo,
  type RequestDetail,
  type RequestEvent,
} from './ServiceRequests';

/**
 * One service request: Overview (details, status, timeline) for everyone;
 * Design and Deploy for the engineers on the customer, on requests that make
 * Design & Build rows (users, phones, call queues, auto attendants).
 *
 * Design embeds the normal Design & Build editors, showing only this
 * request's rows; anything created there is linked to the request. Deploy
 * runs What-If / Deploy on just those rows, and a clean live run moves the
 * request to Deployed. See packages/shared/src/service-request-design.ts.
 */

type PageTab = 'overview' | 'design' | 'deploy';

const STEPS: SrStatus[] = ['new', 'planned', 'built', 'deployed'];

/** The Design & Build tab each request type is designed on. */
const BUILD_TAB_FOR: Partial<Record<SrBuildKind, BuildTab>> = {
  user: 'users',
  cap: 'caps',
  call_queue: 'call-queues',
  auto_attendant: 'auto-attendants',
};

/** Build list query keys, refreshed when a row is linked or removed. */
const BUILD_LIST_KEYS = ['users', 'caps', 'resource-accounts', 'shared-calling-policies', 'call-queues', 'auto-attendants'];

const OBJECT_TYPE_LABEL: Record<DeploymentPreviewRow['objectType'], string> = {
  user: 'User',
  cap: 'Common area phone',
  resource_account: 'Resource account',
  call_queue: 'Call queue',
  auto_attendant: 'Auto attendant',
  shared_calling_policy: 'Shared calling policy',
};
const GROUP_ORDER: DeploymentPreviewRow['objectType'][] = ['user', 'cap', 'resource_account', 'shared_calling_policy', 'call_queue', 'auto_attendant'];

const RESULT_BADGE_COLOR: Record<string, 'success' | 'danger' | 'informative' | 'subtle'> = {
  applied: 'success',
  failed: 'danger',
  whatif: 'informative',
  skipped: 'subtle',
};

const usePageStyles = makeStyles({
  steps: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalXS, rowGap: tokens.spacingVerticalXS },
  stepSep: { color: tokens.colorNeutralForeground4 },
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3 },
  commands: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', whiteSpace: 'pre-wrap', margin: 0 },
  mono: { fontFamily: 'ui-monospace, monospace' },
  warningRow: {
    display: 'flex',
    alignItems: 'flex-start',
    columnGap: '4px',
    ...shorthands.borderRadius('4px'),
    ...shorthands.padding('2px', '6px'),
    marginTop: '4px',
    color: tokens.colorPaletteYellowForeground1,
    backgroundColor: tokens.colorPaletteYellowBackground2,
    fontSize: '12px',
    lineHeight: '16px',
  },
  groupHeaderCell: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
  },
  blockers: { margin: 0, paddingLeft: '20px', color: tokens.colorPaletteMarigoldForeground1 },
  waiting: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorPaletteYellowBorder1),
    backgroundColor: tokens.colorPaletteYellowBackground1,
  },
});

interface RequestPayload {
  request: RequestDetail;
  events: RequestEvent[];
  build: RequestBuildInfo | null;
  sla: { response: SrClock; resolution: SrClock; target: { responseHours: number; resolveHours: number } };
}

export function ServiceRequestPage() {
  const { id = '' } = useParams();
  const { activeTenantId, can, me } = useAuth();
  const ps = usePageStyles();
  const [tab, setTab] = useState<PageTab>('overview');

  const enabled = me?.tenants.find((t) => t.id === activeTenantId)?.managedServices ?? false;
  const base = `/t/${activeTenantId}/service-requests`;
  const canManage = can('sr:manage');

  const q = useQuery({
    queryKey: ['service-request', base, id],
    enabled: !!activeTenantId && enabled && !!id,
    queryFn: () => api<RequestPayload>(`${base}/${id}`),
  });
  const r = q.data?.request;
  const hasDesign = !!r && canManage && can('build:read') && srHasDesign(r.type) && !!r.site_id;
  const canDeployTab = hasDesign && can('deployment:dryrun');
  const editable = !!r && srDesignEditable(r.status);

  const design = useQuery({
    queryKey: ['service-request-design', base, id],
    enabled: hasDesign,
    // Rows made in the embedded editors are linked server-side; poll so the
    // summary above them catches up without wiring every editor to it.
    refetchInterval: tab === 'design' && editable ? 5000 : false,
    queryFn: () => api<SrDesignSummary>(`${base}/${id}/design`),
  });

  if (!activeTenantId) return <NoTenant />;
  if (!enabled) {
    return (
      <Page title="Service request">
        <Card>
          <Text>
            Managed Services isn&apos;t switched on for this customer. A Super Admin can switch it on from <b>Customers</b>.
          </Text>
        </Card>
      </Page>
    );
  }
  if (q.isLoading) return <Spinner label="Loading request…" />;
  if (q.isError || !r) return <LoadError message={q.error ? (q.error as Error).message : 'Request not found.'} />;

  return (
    <Page
      title={`${r.reference} · ${r.title}`}
      subtitle={`${SR_TYPE_DEFS[r.type].label}${r.sitecode ? ` · ${r.site_name ? `${r.sitecode} (${r.site_name})` : r.sitecode}` : ''}`}
      actions={
        <RouterLink to="/service-requests">
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            All requests
          </Button>
        </RouterLink>
      }
    >
      <div className={ps.steps} aria-label="Request progress">
        {r.status === 'cancelled' || r.status === 'declined' ? (
          <Badge appearance="tint" color={STATUS_COLOR[r.status]}>
            {srStatusLabel(r.status, canManage)}
          </Badge>
        ) : (
          STEPS.map((st, i) => {
            const at = STEPS.indexOf(r.status);
            return (
              <span key={st} className={ps.steps}>
                <Badge
                  appearance={i === at ? 'filled' : 'tint'}
                  color={i < at ? 'success' : i === at ? STATUS_COLOR[st] : 'subtle'}
                  icon={i < at ? <CheckmarkRegular /> : undefined}
                >
                  {srStatusLabel(st, canManage)}
                </Badge>
                {i < STEPS.length - 1 && <ChevronRightRegular className={ps.stepSep} />}
              </span>
            );
          })
        )}
      </div>

      {hasDesign && (
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as PageTab)}>
          <Tab value="overview">Overview</Tab>
          <Tab value="design">Design{design.data ? ` (${design.data.items.length})` : ''}</Tab>
          {canDeployTab && <Tab value="deploy">Deploy</Tab>}
        </TabList>
      )}

      {tab === 'overview' && (
        <Overview
          base={base}
          data={q.data!}
          hasDesign={hasDesign}
          canDeployTab={canDeployTab}
          design={design.data}
          onOpenTab={setTab}
        />
      )}
      {tab === 'design' && hasDesign && <DesignTab base={base} data={q.data!} design={design.data} designError={design.error} />}
      {tab === 'deploy' && canDeployTab && <DeployTab base={base} tid={activeTenantId} request={r} design={design.data} />}
    </Page>
  );
}

/* -------------------------------- overview -------------------------------- */

function Overview({
  base,
  data,
  hasDesign,
  canDeployTab,
  design,
  onOpenTab,
}: {
  base: string;
  data: RequestPayload;
  hasDesign: boolean;
  canDeployTab: boolean;
  design: SrDesignSummary | undefined;
  onOpenTab: (t: PageTab) => void;
}) {
  const cs = useSrStyles();
  const ps = usePageStyles();
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const canManage = can('sr:manage');
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  // Team only: a public reply, a question the customer must answer, or an internal note.
  const [commentKind, setCommentKind] = useState<'public' | 'question' | 'internal'>('public');
  const r = data.request;
  const id = r.id;

  const assignees = useQuery({
    queryKey: ['service-request-assignees', base],
    enabled: canManage,
    queryFn: () => api<{ id: string; display_name: string }[]>(`${base}/assignees`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['service-request', base, id] });
    qc.invalidateQueries({ queryKey: ['service-request-design', base, id] });
    qc.invalidateQueries({ queryKey: ['service-requests'] });
  };
  const move = useMutation({
    mutationFn: (to: SrStatus) => api(`${base}/${id}/status`, { method: 'POST', body: JSON.stringify({ to, note: note.trim() || undefined }) }),
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });
  const assign = useMutation({
    mutationFn: (userId: string | null) => api(`${base}/${id}/assign`, { method: 'POST', body: JSON.stringify({ userId }) }),
    onSuccess: refresh,
  });
  const addComment = useMutation({
    mutationFn: () =>
      api(`${base}/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          body: comment,
          internal: canManage && commentKind === 'internal',
          waitForReply: canManage && commentKind === 'question',
        }),
      }),
    onSuccess: () => {
      setComment('');
      setCommentKind('public');
      refresh();
    },
  });
  const resume = useMutation({
    mutationFn: () => api(`${base}/${id}/resume`, { method: 'POST' }),
    onSuccess: refresh,
  });

  const next = nextSrStatus(r.status);
  const own = r.requested_by === me?.id;
  const canCancelOwn = r.status === 'new' && own;
  const canReopen = srCanReopen(r.status, r.deployed_at) && (canManage || own);
  const canDecline = canManage && canMoveSr(r.status, 'declined');
  const canSendBack = canManage && r.status === 'built';
  const canCancel = (canManage || canCancelOwn) && canMoveSr(r.status, 'cancelled');
  const noteMissing = !note.trim();
  const needsNote = (to: SrStatus) => {
    const k = srMoveKind(r.status, to);
    return !!k && SR_NOTE_REQUIRED.includes(k);
  };
  const actionError = move.error ?? assign.error ?? addComment.error ?? resume.error;
  const label = (st: SrStatus) => srStatusLabel(st, canManage);
  // "Designed & built" needs the design done; while the summary loads, hold the button.
  const builtBlockers = next === 'built' && hasDesign ? (design?.builtBlockers ?? null) : [];
  const nextBlocked = builtBlockers === null || builtBlockers.length > 0;
  const deployByTab = next === 'deployed' && canDeployTab;

  return (
    <>
      {r.waiting_since && (
        <div className={ps.waiting}>
          <Text>
            {canManage ? (
              <>
                <b>Waiting on the customer</b> since {when(r.waiting_since)}. The clock is paused, and they're reminded every few days.
              </>
            ) : (
              <>
                <b>The team needs your reply</b> before it can carry on. Answer in a comment below.
              </>
            )}
          </Text>
          {canManage && (
            <Button size="small" disabled={resume.isPending} onClick={() => resume.mutate()}>
              Stop waiting
            </Button>
          )}
        </div>
      )}
      <Card className={ps.card}>
        <div className={cs.facts}>
          <Text className={cs.factLabel}>Status</Text>
          <span>
            <Badge appearance="tint" color={STATUS_COLOR[r.status]}>
              {label(r.status)}
            </Badge>
          </span>
          <Text className={cs.factLabel}>Priority</Text>
          <Text>{PRIORITY_LABEL[r.priority]}</Text>
          <Text className={cs.factLabel}>First response</Text>
          <span>
            <SlaBadge clock={data.sla.response} />{' '}
            <Text size={200} className={ps.muted}>
              target {hoursText(data.sla.target.responseHours)}
            </Text>
          </span>
          <Text className={cs.factLabel}>Completed</Text>
          <span>
            <SlaBadge clock={data.sla.resolution} />{' '}
            <Text size={200} className={ps.muted}>
              target {hoursText(data.sla.target.resolveHours)}
            </Text>
          </span>
          <Text className={cs.factLabel}>Needed by</Text>
          <Text>{day(r.target_date)}</Text>
          <Text className={cs.factLabel}>Raised by</Text>
          <Text>
            {r.requested_by_name ?? '—'} · {when(r.created_at)}
          </Text>
          <Text className={cs.factLabel}>Assigned to</Text>
          {canManage && (r.status === 'new' || r.status === 'planned' || r.status === 'built') ? (
            <Select size="small" value={r.assigned_to ?? ''} disabled={assign.isPending} onChange={(_, d) => assign.mutate(d.value || null)}>
              <option value="">Unassigned</option>
              {(assignees.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name}
                </option>
              ))}
            </Select>
          ) : (
            <Text>{r.assigned_to_name ?? 'Unassigned'}</Text>
          )}
        </div>

        <div className={cs.section}>
          <Text weight="semibold">Request details</Text>
          <div className={cs.facts}>
            {srDetailLines(r.type, r.details).map((l) => (
              <FactRow key={l.label} label={l.label} value={l.value} />
            ))}
          </div>
        </div>
      </Card>

      {/* A new site (or anything without a Design tab) is still drafted from here. */}
      {!hasDesign && data.build?.canDraft && data.build.kind && (
        <Card className={ps.card}>
          <BuildDraftSection base={base} id={id} kind={data.build.kind} suggestedCapUpn={data.build.suggestedCapUpn} onDone={refresh} />
        </Card>
      )}

      {(canManage && next) || canCancel || canDecline || canSendBack || canReopen ? (
        <Card className={ps.card}>
          <Text weight="semibold">{r.status === 'deployed' ? 'Something wrong?' : 'Move this request on'}</Text>
          {hasDesign && r.status === 'new' && canManage && (
            <Text size={200} className={ps.muted}>
              Mark it as planned to start designing it on the Design tab.
            </Text>
          )}
          {next === 'built' && hasDesign && builtBlockers && builtBlockers.length > 0 && (
            <div>
              <ul className={ps.blockers}>
                {builtBlockers.map((b) => (
                  <li key={b}>
                    <Text size={200}>{b}</Text>
                  </li>
                ))}
              </ul>
              <Link onClick={() => onOpenTab('design')}>Open the Design tab</Link>
            </div>
          )}
          {deployByTab && (
            <Text size={200} className={ps.muted}>
              Deploy it from the <Link onClick={() => onOpenTab('deploy')}>Deploy tab</Link>. A deployment with no failed changes marks it as
              deployed and emails the requester. Only mark it by hand if it was deployed some other way.
            </Text>
          )}
          {r.status === 'deployed' && canReopen && (
            <Text size={200} className={ps.muted}>
              If the change isn&apos;t working, reopen the request within {SR_REOPEN_DAYS} days of it being completed and say what&apos;s wrong.
            </Text>
          )}
          <Field
            hint={
              canManage
                ? 'Included in the email to the requester. Needed to decline, send back or reopen.'
                : r.status === 'deployed'
                  ? "Say what isn't working."
                  : undefined
            }
          >
            <Textarea
              value={note}
              maxLength={4000}
              placeholder={r.status === 'deployed' ? "What isn't working?" : 'Add a note'}
              resize="vertical"
              onChange={(_, d) => setNote(d.value)}
            />
          </Field>
          <div className={cs.actions}>
            {canManage && next && (
              <Button
                appearance={deployByTab ? 'secondary' : 'primary'}
                disabled={move.isPending || nextBlocked}
                onClick={() => move.mutate(next)}
              >
                Mark as {label(next).toLowerCase()}
              </Button>
            )}
            {canSendBack && (
              <Button disabled={move.isPending || noteMissing} title="Back to Planned, e.g. the design needs changing or a deploy failed." onClick={() => move.mutate('planned')}>
                Send back to planned
              </Button>
            )}
            {canReopen && (
              <Button appearance="primary" disabled={move.isPending || noteMissing} onClick={() => move.mutate('planned')}>
                Reopen
              </Button>
            )}
            {canDecline && (
              <Button disabled={move.isPending || noteMissing} title="The team won't do this request. The requester is told why." onClick={() => move.mutate('declined')}>
                Decline
              </Button>
            )}
            {canCancel && (
              <Button disabled={move.isPending || (needsNote('cancelled') && noteMissing)} onClick={() => move.mutate('cancelled')}>
                Cancel request
              </Button>
            )}
          </div>
        </Card>
      ) : null}

      <Card className={ps.card}>
        <Text weight="semibold">Timeline</Text>
        {data.events.map((e) => (
          <div key={e.id} className={`${cs.event} ${e.internal ? cs.internal : ''}`}>
            <Text size={200}>
              <b>{e.author_name ?? 'Someone'}</b> · {when(e.created_at)}
              {e.internal ? ' · internal note' : ''}
            </Text>
            <Text style={{ whiteSpace: 'pre-wrap' }}>{eventText(e, canManage)}</Text>
            {e.links && e.links.length > 0 && <BuildLinks links={e.links} />}
            {e.kind === 'deployment' && canDeployTab && <Link onClick={() => onOpenTab('deploy')}>See the run on the Deploy tab</Link>}
          </div>
        ))}

        {can('sr:create') && (
          <div className={cs.section}>
            <Field label="Add a comment">
              <Textarea value={comment} maxLength={4000} resize="vertical" onChange={(_, d) => setComment(d.value)} />
            </Field>
            {canManage && (
              <RadioGroup layout="horizontal" value={commentKind} onChange={(_, d) => setCommentKind(d.value as typeof commentKind)}>
                <Radio value="public" label="Reply to the customer" />
                <Radio value="question" label="Ask the customer and wait for their reply" disabled={!['new', 'planned', 'built'].includes(r.status)} />
                <Radio value="internal" label="Internal note (the customer won't see it)" />
              </RadioGroup>
            )}
            <div className={cs.actions}>
              <Button disabled={!comment.trim() || addComment.isPending} onClick={() => addComment.mutate()}>
                {commentKind === 'question' && canManage ? 'Ask and wait' : 'Add comment'}
              </Button>
            </div>
          </div>
        )}
        {actionError && <Text className={cs.error}>{errorText(actionError, 'That did not work')}</Text>}
      </Card>
    </>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  const cs = useSrStyles();
  return (
    <>
      <Text className={cs.factLabel}>{label}</Text>
      <Text style={{ whiteSpace: 'pre-wrap' }}>{value}</Text>
    </>
  );
}

function eventText(e: RequestEvent, staff: boolean): string {
  switch (e.kind) {
    case 'created':
      return 'Raised the request.';
    case 'status_changed': {
      const k = e.from_status && e.to_status ? srMoveKind(e.from_status, e.to_status) : null;
      const label = (st: SrStatus | null) => (st ? srStatusLabel(st, staff) : '—');
      const moved =
        k === 'reopen'
          ? 'Reopened the request.'
          : k === 'send_back'
            ? `Sent it back to ${label(e.to_status)}.`
            : k === 'decline'
              ? 'Declined the request.'
              : `Moved from ${label(e.from_status)} to ${label(e.to_status)}.`;
      return e.body ? `${moved} ${e.body}` : moved;
    }
    case 'waiting':
      return `Asked: ${e.body ?? ''}`;
    case 'resumed':
      return staff ? 'No longer waiting on the customer.' : 'No longer waiting for your reply.';
    case 'assigned':
      return e.body === 'Unassigned' ? 'Unassigned the request.' : `Assigned to ${e.body}.`;
    case 'comment':
    case 'build_drafted':
    case 'deployment':
      return e.body ?? '';
  }
}

/* --------------------------------- design --------------------------------- */

function DesignTab({
  base,
  data,
  design,
  designError,
}: {
  base: string;
  data: RequestPayload;
  design: SrDesignSummary | undefined;
  designError: unknown;
}) {
  const ps = usePageStyles();
  const cs = useSrStyles();
  const qc = useQueryClient();
  const r = data.request;
  const editable = srDesignEditable(r.status);
  const kind = SR_BUILD_KIND[r.type];

  // While this tab is open on a Planned request, Design & Build rows created
  // below are linked to the request (see api.ts).
  useEffect(() => {
    if (!editable) return;
    setDesigningServiceRequest(r.id);
    return () => setDesigningServiceRequest(null);
  }, [editable, r.id]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['service-request', base, r.id] });
    qc.invalidateQueries({ queryKey: ['service-request-design', base, r.id] });
    for (const k of BUILD_LIST_KEYS) qc.invalidateQueries({ queryKey: [k] });
  };
  const unlink = useMutation({
    mutationFn: (item: SrItem) => api(`${base}/${r.id}/items/${item.kind}/${item.row_id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const lockedWhy =
    r.status === 'new'
      ? 'Mark the request as planned to start designing it.'
      : `The design is locked because the request is ${SR_STATUS_LABELS[r.status]}.`;

  return (
    <>
      <Card className={ps.card}>
        <Text weight="semibold" size={400}>
          Designed for {r.reference}
        </Text>
        <Text size={200} className={ps.muted}>
          {editable
            ? `Design the request with the same editors as Design & Build, below. Anything you add here belongs to ${r.reference}: it also shows on the site's Design & Build page, tagged ${r.reference}, and the Deploy tab deploys just these rows.`
            : lockedWhy}
        </Text>
        {designError ? <LoadError message={(designError as Error).message} /> : null}
        {!design ? (
          <Spinner size="tiny" />
        ) : design.items.length === 0 ? (
          <Text size={200}>Nothing designed yet.</Text>
        ) : (
          <DataTable size="small" minWidth={520}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {design.items.map((i) => (
                <TableRow key={`${i.kind}:${i.row_id}`}>
                  <TableCell>{SR_ITEM_KIND_LABELS[i.kind]}</TableCell>
                  <TableCell>
                    {i.label ?? (
                      <Badge appearance="tint" color="danger">
                        Deleted from Design & Build
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {editable && (
                      <Button
                        size="small"
                        appearance="subtle"
                        disabled={unlink.isPending}
                        title="Takes the row off this request. It stays in Design & Build."
                        onClick={() => unlink.mutate(i)}
                      >
                        Remove from request
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
        {unlink.error && <Text className={cs.error}>{errorText(unlink.error, 'Could not remove the row')}</Text>}
        {design && design.builtBlockers.length === 0 && r.status === 'planned' && (
          <Text size={200}>Ready: mark the request as designed &amp; built on the Overview tab, then deploy it.</Text>
        )}
        {editable && data.build?.canDraft && data.build.kind && (
          <BuildDraftSection
            base={base}
            id={r.id}
            kind={data.build.kind}
            suggestedCapUpn={data.build.suggestedCapUpn}
            onDone={refresh}
            change={isSrChangeType(r.type)}
          />
        )}
      </Card>

      {r.status !== 'new' && r.site_id && (
        <BuildSiteWorkspace
          embedded={{ siteId: r.site_id, requestId: r.id, reference: r.reference, editable, tab: kind ? BUILD_TAB_FOR[kind] : undefined }}
        />
      )}
    </>
  );
}

/**
 * Creates the request's main row from the customer's answers (see
 * service-request-build.ts) and links it to the request. Doesn't change the
 * request's status.
 */
function BuildDraftSection({
  base,
  id,
  kind,
  suggestedCapUpn,
  onDone,
  change = false,
}: {
  base: string;
  id: string;
  kind: SrBuildKind;
  suggestedCapUpn: string | null;
  onDone: () => void;
  /** A change or removal: links the existing row and applies the request to it. */
  change?: boolean;
}) {
  const cs = useSrStyles();
  const [capUpn, setCapUpn] = useState(suggestedCapUpn ?? '');
  const draft = useMutation({
    mutationFn: () =>
      api<SrBuildDraftResult>(`${base}/${id}/build-draft`, {
        method: 'POST',
        body: JSON.stringify(kind === 'cap' ? { capUpn: capUpn.trim() } : {}),
      }),
    onSuccess: onDone,
  });
  const result = draft.data;
  const what = kind === 'site' ? 'the new site' : `the ${SR_BUILD_KIND_LABELS[kind].toLowerCase()}`;
  if (change) {
    return (
      <div className={cs.section}>
        <Text weight="semibold">Apply the request</Text>
        <Text size={200}>
          Finds the {SR_BUILD_KIND_LABELS[kind].toLowerCase()} in Design &amp; Build (adding a user to this site if they aren&apos;t there yet), adds it to this
          request, and makes the changes that can be made automatically. Anything else is listed for you to finish below.
        </Text>
        <div className={cs.actions}>
          <Button disabled={draft.isPending} onClick={() => draft.mutate()}>
            Apply the request
          </Button>
          {draft.isPending && <Spinner size="tiny" />}
        </div>
        {result && (
          <div>
            <BuildLinks links={[...result.created, ...result.existing]} />
            {result.applied && result.applied.length > 0 && <Text block>Applied: {result.applied.join('; ')}.</Text>}
            {result.applied && result.applied.length === 0 && <Text block>Nothing could be applied automatically.</Text>}
          </div>
        )}
        {result && result.warnings.length > 0 && (
          <div>
            <Text weight="semibold">Still to do</Text>
            <ul style={{ margin: 0, paddingLeft: '20px' }}>
              {result.warnings.map((w) => (
                <li key={w}>
                  <Text size={200}>{w}</Text>
                </li>
              ))}
            </ul>
          </div>
        )}
        {draft.error && <Text className={cs.error}>{errorText(draft.error, 'Could not apply the request')}</Text>}
      </div>
    );
  }
  return (
    <div className={cs.section}>
      <Text weight="semibold">Prefill from the request</Text>
      <Text size={200}>
        Creates {what} from the customer&apos;s answers, so you don&apos;t have to retype them{kind === 'site' ? '' : ', then finish it below (phone number, policies, routing)'}.
      </Text>
      {kind === 'cap' && (
        <Field label="Account sign-in address (UPN)" required hint="The customer isn't asked for this. Suggested from the phone's name.">
          <Input value={capUpn} onChange={(_, d) => setCapUpn(d.value)} placeholder="e.g. reception.desk@contoso.com" />
        </Field>
      )}
      <div className={cs.actions}>
        <Button disabled={draft.isPending || (kind === 'cap' && !capUpn.trim())} onClick={() => draft.mutate()}>
          {kind === 'site' ? 'Create the site' : `Prefill ${SR_BUILD_KIND_LABELS[kind].toLowerCase()}`}
        </Button>
        {draft.isPending && <Spinner size="tiny" />}
      </div>
      {result && result.created.length > 0 && (
        <div>
          <Text>Created:</Text>
          <BuildLinks links={result.created} />
        </div>
      )}
      {result && result.existing.length > 0 && (
        <div>
          <Text>Already in Design & Build, so it was added to this request unchanged:</Text>
          <BuildLinks links={result.existing} />
        </div>
      )}
      {result?.warnings.map((w) => (
        <Text key={w} className={cs.error}>
          {w}
        </Text>
      ))}
      {draft.error && <Text className={cs.error}>{errorText(draft.error, 'Could not create the row')}</Text>}
    </div>
  );
}

function BuildLinks({ links }: { links: SrBuildLink[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: '20px' }}>
      {links.map((l) => (
        <li key={l.href + l.label}>
          <RouterLink to={l.href}>
            {SR_BUILD_KIND_LABELS[l.kind]}: {l.label}
          </RouterLink>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------- deploy --------------------------------- */

interface Connection {
  id: string;
  status: string;
}
interface Change {
  id: string;
  seq: number;
  cmdlet: string;
  object_type: string;
  result: string;
  message: string | null;
}

function runBadge(d: SrDeploymentRun): { label: string; color: 'success' | 'danger' | 'informative' } {
  const failed = d.summary?.failed ?? 0;
  if (d.status === 'failed') return { label: 'Failed', color: 'danger' };
  if (d.status === 'completed' && failed > 0) return { label: `Finished, ${failed} failed`, color: 'danger' };
  if (d.status === 'completed') return { label: 'Finished', color: 'success' };
  return { label: d.status === 'queued' ? 'Queued' : 'Running', color: 'informative' };
}

function DeployTab({ base, tid, request: r, design }: { base: string; tid: string; request: RequestDetail; design: SrDesignSummary | undefined }) {
  const ps = usePageStyles();
  const cs = useSrStyles();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canExecute = can('deployment:execute');
  const [confirm, setConfirm] = useState(false);
  const [runFor, setRunFor] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: ['connections', tid],
    refetchInterval: 4000,
    queryFn: () => api<Connection[]>(`/t/${tid}/deployments/connections`),
  });
  const activeConn = connections.data?.find((c) => c.status === 'active');

  const hasRows = (design?.deployableCount ?? 0) > 0;
  const preview = useQuery({
    queryKey: ['sr-deploy-preview', base, r.id],
    enabled: hasRows,
    queryFn: () => api<DeploymentPreviewRow[]>(`${base}/${r.id}/deploy-preview`),
  });
  const runs = useQuery({
    queryKey: ['sr-runs', base, r.id],
    refetchInterval: 4000,
    queryFn: () => api<SrDeploymentRun[]>(`${base}/${r.id}/runs`),
  });
  const changes = useQuery({
    queryKey: ['changes', tid, runFor],
    enabled: !!runFor,
    queryFn: () => api<Change[]>(`/t/${tid}/deployments/${runFor}/changes`),
  });

  // A finished live run may have moved the request to Deployed (in the
  // worker) - pick that up, and the new preview, as runs finish.
  const finished = (runs.data ?? []).filter((d) => d.status === 'completed' || d.status === 'failed').length;
  useEffect(() => {
    if (!finished) return;
    qc.invalidateQueries({ queryKey: ['service-request', base, r.id] });
    qc.invalidateQueries({ queryKey: ['sr-deploy-preview', base, r.id] });
    qc.invalidateQueries({ queryKey: ['service-requests'] });
  }, [finished, base, r.id, qc]);

  const run = useMutation({
    mutationFn: (mode: 'dry_run' | 'execute') =>
      api(`${base}/${r.id}/deploy`, { method: 'POST', body: JSON.stringify({ connectionId: activeConn?.id, mode }) }),
    onSuccess: () => {
      setConfirm(false);
      qc.invalidateQueries({ queryKey: ['sr-runs', base, r.id] });
    },
  });

  const rows = preview.data ?? [];
  const busy = (runs.data ?? []).some((d) => d.status === 'queued' || d.status === 'running');
  const canWhatIf = r.status === 'planned' || r.status === 'built';
  const canLive = r.status === 'built' && canExecute;

  return (
    <>
      <Card className={ps.card}>
        <div className={cs.actions} style={{ justifyContent: 'space-between' }}>
          <Text weight="semibold" size={400}>
            Changes for {r.reference} <span className={ps.muted}>({rows.length})</span>
          </Text>
          <div className={cs.actions}>
            <Button disabled={!activeConn || !canWhatIf || !hasRows || busy || run.isPending} onClick={() => run.mutate('dry_run')}>
              What-If
            </Button>
            <Button appearance="primary" disabled={!activeConn || !canLive || !hasRows || busy || run.isPending} onClick={() => setConfirm(true)}>
              Deploy
            </Button>
          </div>
        </div>
        <Text size={200} className={ps.muted}>
          Only this request&apos;s rows are deployed, plus the resource accounts its call queues and auto attendants answer on, and any users
          they route to. What-If checks everything and sends nothing to Microsoft Teams.
          {r.status === 'planned' && ' Deploy is available once the request is marked as designed & built.'}
          {r.status === 'built' && ' A deployment with no failed changes marks the request as deployed and emails the requester.'}
          {r.status === 'deployed' && ' This request is deployed.'}
          {!canExecute && ' You can run What-If; a live deployment needs an engineer who can deploy.'}
        </Text>
        {!activeConn && (
          <Text size={200}>
            <WarningRegular /> No active connection to the customer&apos;s tenant. Connect from <RouterLink to="/deployment">Deployment</RouterLink>, then come back.
          </Text>
        )}
        {run.error && <Text className={cs.error}>{errorText(run.error, 'Could not start the run')}</Text>}

        {!hasRows ? (
          <Text size={200}>Nothing designed for this request yet. Add rows on the Design tab.</Text>
        ) : preview.isLoading ? (
          <Spinner size="tiny" />
        ) : preview.isError ? (
          <LoadError message={(preview.error as Error).message} />
        ) : rows.length === 0 ? (
          <Text size={200}>Nothing to change: the request&apos;s rows already match the tenant.</Text>
        ) : (
          <DataTable size="small" minWidth={820}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Object</TableHeaderCell>
                <TableHeaderCell>Commands</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {GROUP_ORDER.flatMap((type) => {
                const group = rows.filter((x) => x.objectType === type);
                if (group.length === 0) return [];
                return [
                  <TableRow key={`g-${type}`}>
                    <TableCell colSpan={2} className={ps.groupHeaderCell}>
                      {OBJECT_TYPE_LABEL[type]} · {group.length}
                    </TableCell>
                  </TableRow>,
                  ...group.map((x) => (
                    <TableRow key={x.rowId}>
                      <TableCell>
                        {x.upn}
                        {x.autoIncluded && (
                          <Badge appearance="tint" color="brand" style={{ marginLeft: 6 }} title="Not on the request itself: included because a call queue or auto attendant on it routes to this user.">
                            included automatically
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {x.renderedCommands.length > 0 && <pre className={ps.commands}>{x.renderedCommands.join('\n')}</pre>}
                        {x.warnings.map((w) => (
                          <div key={w} className={ps.warningRow}>
                            <WarningRegular style={{ flexShrink: 0, marginTop: 2 }} />
                            <span>{w}</span>
                          </div>
                        ))}
                      </TableCell>
                    </TableRow>
                  )),
                ];
              })}
            </TableBody>
          </DataTable>
        )}
      </Card>

      <Card className={ps.card}>
        <Text weight="semibold" size={400}>
          Runs
        </Text>
        {(runs.data ?? []).length === 0 ? (
          <Text size={200}>No runs yet.</Text>
        ) : (
          <DataTable size="small" minWidth={720}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Started</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
                <TableHeaderCell>Result</TableHeaderCell>
                <TableHeaderCell>Changes</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data!.map((d) => {
                const b = runBadge(d);
                return (
                  <TableRow key={d.id}>
                    <TableCell>{when(d.created_at)}</TableCell>
                    <TableCell>{d.mode === 'execute' ? 'Deploy' : 'What-If'}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={b.color}>
                        {b.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {Object.entries(d.summary ?? {})
                        .filter(([k]) => k !== 'total')
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ') || '—'}
                    </TableCell>
                    <TableCell>
                      <Link onClick={() => setRunFor(runFor === d.id ? null : d.id)}>{runFor === d.id ? 'Hide' : 'View'} changes</Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </DataTable>
        )}
        {runFor &&
          (changes.isLoading ? (
            <Spinner size="tiny" />
          ) : (
            <DataTable size="small" minWidth={820}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>#</TableHeaderCell>
                  <TableHeaderCell>Object</TableHeaderCell>
                  <TableHeaderCell>Cmdlet</TableHeaderCell>
                  <TableHeaderCell>Result</TableHeaderCell>
                  <TableHeaderCell>Detail</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(changes.data ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.seq}</TableCell>
                    <TableCell>{c.object_type}</TableCell>
                    <TableCell className={ps.mono}>{c.cmdlet}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={RESULT_BADGE_COLOR[c.result] ?? 'informative'}>
                        {c.result}
                      </Badge>
                    </TableCell>
                    <TableCell className={ps.mono}>
                      <div style={{ maxWidth: 420, whiteSpace: 'pre-wrap' }}>{c.message ?? ''}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          ))}
      </Card>

      <Dialog open={confirm} onOpenChange={(_, d) => setConfirm(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Deploy {r.reference}?</DialogTitle>
            <DialogContent>
              <Text block>
                This makes the {rows.length} change{rows.length === 1 ? '' : 's'} above live in the customer&apos;s Microsoft Teams tenant. Nothing
                else on the site is touched.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button appearance="primary" disabled={run.isPending} onClick={() => run.mutate('execute')}>
                Deploy now
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
