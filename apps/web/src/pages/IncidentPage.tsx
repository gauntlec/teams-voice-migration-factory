import { useRef, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Link,
  Radio,
  RadioGroup,
  Select,
  Spinner,
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

  mergeClasses,
} from '@fluentui/react-components';
import { ArrowLeftRegular, CheckmarkRegular, ChevronRightRegular, DeleteRegular, WarningRegular } from '@fluentui/react-icons';
import {
  INC_CATEGORY_BY_KEY,
  INC_HOLD_LABELS,
  INC_HOLD_REASONS,
  INC_IMPACT_LABELS,
  INC_ITEM_KINDS,
  INC_NOTE_REQUIRED,
  INC_PRIORITIES,
  INC_PRIORITY_LABELS,
  INC_REOPEN_DAYS,
  INC_STATUS_CUSTOMER_LABELS,
  INC_STATUS_LABELS,
  INC_URGENCY_LABELS,
  agentLabel,
  incCategoryLabel,
  incDetailLines,
  incMoveKind,
  type FileRow,
  type IncClock,
  type IncDetails,
  type IncEventKind,
  type IncHoldReason,
  type IncItemKind,
  type IncMoveKind,
  type IncPriority,
  type IncSlaTarget,
  type IncStatus,
  type IncImpact,
  type IncUrgency,
} from '@tvmf/shared';
import { api, apiDownload, apiUpload } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { AskAssistantCard, IncidentAssistantCard, type AssistantInfo } from '../components/IncidentAssistant';
import { IncidentChecks } from '../components/IncidentChecks';
import { KnowledgeSuggestions, SaveKnowledgeButton } from '../components/IncidentKnowledge';
import { IncidentMajorSection, type ChildIncident, type MajorInfo, type ParentIncident } from '../components/IncidentMajor';
import { IncidentProblemCard, type LinkedProblem } from '../components/IncidentProblemCard';
import { IncidentReviewCard, type ReviewInfo } from '../components/IncidentReview';
import { INC_STATUS_COLOR, IncSlaBadge, IncStatusBadge, PriorityBadge, type IncidentRow } from '../components/IncidentBits';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from '../components/records';
import { errorText, useSrStyles, when } from './ServiceRequests';

const useLocalStyles = makeStyles({
  preWrap: { whiteSpace: "pre-wrap" },
  pl20Margin0: { ...shorthands.margin("0px"), paddingLeft: '20px' },
  styled: { gridTemplateColumns: "170px minmax(0, 1fr) 160px" },
  justifySpacebetween: { justifyContent: "space-between" },
  none: { display: "none" },
});


const usePageStyles = makeStyles({
  steps: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalXS, rowGap: tokens.spacingVerticalXS },
  stepSep: { color: tokens.colorNeutralForeground4 },
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3 },
  banner: {
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
  good: { ...shorthands.border('1px', 'solid', tokens.colorPaletteGreenBorder1), backgroundColor: tokens.colorPaletteGreenBackground1 },
  emergency: { ...shorthands.border('1px', 'solid', tokens.colorPaletteRedBorder1), backgroundColor: tokens.colorPaletteRedBackground1 },
  pair: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS },
  twoCol: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px 140px', columnGap: tokens.spacingHorizontalS, alignItems: 'end' },
});

interface IncidentEvent {
  id: string;
  kind: IncEventKind;
  from_status: string | null;
  to_status: string | null;
  body: string | null;
  internal: boolean;
  actor_type: 'user' | 'agent' | 'system';
  author_name: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

interface IncidentPayload {
  incident: Omit<IncidentRow, 'sla' | 'reporter_name'> & {
    assigned_agent_name?: string | null;
    description: string;
    details: IncDetails;
    impact: IncImpact;
    urgency: IncUrgency;
    site_name: string | null;
    reporter_name: string | null;
    hold_reason: IncHoldReason | null;
    priority_overridden?: boolean;
    source?: string;
    resolved_at: string | null;
    restored_at: string | null;
  };
  sla: { response: IncClock; restoration: IncClock; resolution: IncClock; target: IncSlaTarget; cover: 'business' | '24x7' };
  can: { confirmFixed: boolean; reopen: boolean; cancel: boolean };
  watching: boolean;
  watchers?: { id: string; display_name: string }[];
  major: MajorInfo | null;
  children: ChildIncident[];
  parent: ParentIncident | null;
  problem: LinkedProblem | null;
  review: ReviewInfo | null;
  /** Staff only: the AI assistant's claim, whether a person took over, and its proposals. */
  agent?: AssistantInfo;
  items: { id: string; kind: IncItemKind; ref: string; label: string | null }[];
  events: IncidentEvent[];
}

const ITEM_LABEL: Record<IncItemKind, string> = {
  site: 'Site',
  user: 'Person',
  number: 'Phone number',
  call_queue: 'Call queue',
  auto_attendant: 'Auto attendant',
  cap: 'Common area phone',
  service_request: 'Service request',
  deployment: 'Deployment',
  number_port: 'Number port',
};

const STEPS: IncStatus[] = ['new', 'in_progress', 'restored', 'resolved', 'closed'];

/** The progress strip's own labels: "please confirm" belongs on the status, not on every step. */
const STEP_LABEL: Record<string, string> = { new: 'Received', in_progress: 'Being worked on', restored: 'Service restored', resolved: 'Resolved', closed: 'Closed' };

const MOVE_LABEL: Record<IncMoveKind, string> = {
  acknowledge: 'Acknowledge',
  progress: 'Back in progress',
  hold: 'Put on hold',
  resume: 'Resume work',
  restore: 'Service restored',
  resolve: 'Mark resolved',
  close: 'Close',
  reopen: 'Reopen',
  cancel: 'Cancel incident',
  duplicate: 'Mark as duplicate',
};

function targetText(minutes: number, cover: 'business' | '24x7') {
  return `${minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}${cover === 'business' ? ' of working time' : ''}`;
}
function hoursText(h: number | null, cover: 'business' | '24x7') {
  return h === null ? 'none' : `${h < 48 || cover === 'business' ? `${h} h` : `${Math.round(h / 24)} days`}${cover === 'business' ? ' of working time' : ''}`;
}

/** One incident: what it is, where it stands, what the team has done, and what you can do next. */
export function IncidentPage() {
  const { id = '' } = useParams();
  const { activeTenantId, can, me } = useAuth();
  const ps = usePageStyles();
  const enabled = me?.tenants.find((t) => t.id === activeTenantId)?.managedServices ?? false;
  const base = `/t/${activeTenantId}/incidents`;
  const staff = can('inc:manage');

  const q = useQuery({
    queryKey: ['incident', base, id],
    enabled: !!activeTenantId && enabled && !!id,
    queryFn: () => api<IncidentPayload>(`${base}/${id}`),
    refetchInterval: 30_000,
  });

  if (!activeTenantId) return <NoTenant />;
  if (!enabled) {
    return (
      <Page narrow title="Incident">
        <Card>
          <Text>
            Managed Services isn&apos;t switched on for this customer. A Super Admin can switch it on from <b>Customers</b>.
          </Text>
        </Card>
      </Page>
    );
  }
  if (q.isLoading) return <Spinner label="Loading incident…" />;
  if (q.isError || !q.data) return <LoadError message={q.error ? (q.error as Error).message : 'Incident not found.'} />;
  const data = q.data;
  const r = data.incident;
  const label = staff ? INC_STATUS_LABELS : INC_STATUS_CUSTOMER_LABELS;
  const at = STEPS.indexOf(r.status === 'on_hold' ? 'in_progress' : r.status);

  return (
    <Page narrow
      title={`${r.reference} · ${r.title}`}
      subtitle={`${incCategoryLabel(r.category, r.subcategory)}${r.sitecode ? ` · ${r.site_name ? `${r.sitecode} (${r.site_name})` : r.sitecode}` : ' · All sites'}`}
      actions={
        <RouterLink to="/incidents">
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            All incidents
          </Button>
        </RouterLink>
      }
    >
      <div className={ps.steps} aria-label="Incident progress">
        {r.status === 'cancelled' || r.status === 'duplicate' ? (
          <Badge appearance="tint" color="subtle">
            {label[r.status]}
          </Badge>
        ) : (
          <>
            {STEPS.map((st, i) => (
              <span key={st} className={ps.steps}>
                <Badge appearance={i === at ? 'filled' : 'tint'} color={i < at ? 'success' : i === at ? INC_STATUS_COLOR[st] : 'subtle'} icon={i < at ? <CheckmarkRegular /> : undefined}>
                  {staff ? label[st] : STEP_LABEL[st]}
                </Badge>
                {i < STEPS.length - 1 && <ChevronRightRegular className={ps.stepSep} />}
              </span>
            ))}
            {r.status === 'on_hold' && <IncStatusBadge status="on_hold" hold={r.hold_reason} staff={staff} />}
          </>
        )}
      </div>
      <Overview base={base} data={data} />
    </Page>
  );
}

function Overview({ base, data }: { base: string; data: IncidentPayload }) {
  const ls = useLocalStyles();
  const cs = useSrStyles();
  const ps = usePageStyles();
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const staff = can('inc:manage');
  const r = data.incident;
  const id = r.id;
  const [note, setNote] = useState('');
  const [holdReason, setHoldReason] = useState<IncHoldReason | ''>('');
  const [resolveChildren, setResolveChildren] = useState(false);
  const [duplicateOf, setDuplicateOf] = useState('');
  const [comment, setComment] = useState('');
  const [commentKind, setCommentKind] = useState<'public' | 'question' | 'internal'>('public');
  const [newPriority, setNewPriority] = useState<IncPriority | ''>('');
  const [priorityReason, setPriorityReason] = useState('');
  const [itemKind, setItemKind] = useState<IncItemKind>('user');
  const [itemRef, setItemRef] = useState('');

  const live = ['new', 'in_progress', 'on_hold', 'restored', 'resolved'].includes(r.status);
  const emergency = INC_CATEGORY_BY_KEY[r.category]?.forcePriority === 'p1';

  const assignees = useQuery({
    queryKey: ['incident-assignees', base],
    enabled: staff,
    queryFn: () => api<{ id: string; display_name: string }[]>(`${base}/assignees`),
  });
  const assistants = useQuery({
    queryKey: ['incident-agents', base],
    enabled: staff,
    queryFn: () => api<{ id: string; name: string }[]>(`${base}/agents`),
  });
  const others = useQuery({
    queryKey: ['incident-others', base],
    enabled: staff && r.status !== 'closed',
    queryFn: () => api<IncidentRow[]>(`${base}?status=all&limit=500`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['incident', base, id] });
    qc.invalidateQueries({ queryKey: ['incidents'] });
  };
  const move = useMutation({
    mutationFn: (to: IncStatus) =>
      api(`${base}/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ to, note: note.trim() || undefined, holdReason: to === 'on_hold' ? holdReason || undefined : undefined, duplicateOf: to === 'duplicate' ? duplicateOf || undefined : undefined, resolveChildren: to === 'resolved' && resolveChildren ? true : undefined }),
      }),
    onSuccess: () => {
      setNote('');
      setHoldReason('');
      setDuplicateOf('');
      setResolveChildren(false);
      refresh();
    },
  });
  const assign = useMutation({ mutationFn: (who: { userId: string | null } | { agentId: string }) => api(`${base}/${id}/assign`, { method: 'POST', body: JSON.stringify(who) }), onSuccess: refresh });
  const setPriority = useMutation({
    mutationFn: () => api(`${base}/${id}/priority`, { method: 'POST', body: JSON.stringify({ priority: newPriority, reason: priorityReason }) }),
    onSuccess: () => {
      setNewPriority('');
      setPriorityReason('');
      refresh();
    },
  });
  const addComment = useMutation({
    mutationFn: () => api(`${base}/${id}/comments`, { method: 'POST', body: JSON.stringify({ body: comment, internal: staff && commentKind === 'internal', waitForReply: staff && commentKind === 'question' }) }),
    onSuccess: () => {
      setComment('');
      setCommentKind('public');
      refresh();
    },
  });
  const watch = useMutation({
    mutationFn: (on: boolean) => (on ? api(`${base}/${id}/watchers`, { method: 'POST', body: JSON.stringify({}) }) : api(`${base}/${id}/watchers`, { method: 'DELETE' })),
    onSuccess: refresh,
  });
  const addItem = useMutation({
    mutationFn: () => api(`${base}/${id}/items`, { method: 'POST', body: JSON.stringify({ kind: itemKind, ref: itemRef.trim() }) }),
    onSuccess: () => {
      setItemRef('');
      refresh();
    },
  });
  const removeItem = useMutation({ mutationFn: (itemId: string) => api(`${base}/${id}/items/${itemId}`, { method: 'DELETE' }), onSuccess: refresh });

  const kindTo = (to: IncStatus) => incMoveKind(r.status, to);
  const needsNote = (to: IncStatus) => {
    const k = kindTo(to);
    return !!k && INC_NOTE_REQUIRED.includes(k) && !(k === 'cancel' && !staff);
  };
  const noteMissing = !note.trim();
  const actionError = move.error ?? assign.error ?? setPriority.error ?? addComment.error ?? watch.error ?? addItem.error ?? removeItem.error;
  const target = data.sla.target;
  const lines = incDetailLines(r.category, r.details.answers ?? {});
  const customerWaiting = r.status === 'on_hold' && r.hold_reason === 'customer';

  // What this person can do next.
  const staffMoves = staff
    ? (
        [
          ['in_progress', kindTo('in_progress') && kindTo('in_progress') !== 'reopen' ? 'primary' : 'secondary'],
          ['restored', 'secondary'],
          ['resolved', 'secondary'],
          ['closed', 'secondary'],
        ] as const
      ).filter(([to]) => kindTo(to as IncStatus))
    : [];
  const canReopen = data.can.reopen;
  const showActions = staff ? live || canReopen : data.can.confirmFixed || data.can.reopen || data.can.cancel;

  return (
    <>
      {emergency && live && (
        <div className={`${ps.banner} ${ps.emergency}`}>
          <Text>
            <WarningRegular /> <b>Emergency calling.</b> If anyone is in danger right now, use another phone to call the emergency services.
          </Text>
        </div>
      )}
      {customerWaiting && (
        <div className={ps.banner}>
          <Text>
            {staff ? (
              <>
                <b>Waiting on the customer.</b> The clocks are paused until they reply.
              </>
            ) : (
              <>
                <b>The team needs your reply</b> before it can carry on. Answer in a comment below.
              </>
            )}
          </Text>
        </div>
      )}
      {data.can.confirmFixed && (
        <div className={`${ps.banner} ${ps.good}`}>
          <Text>
            <b>The team says this is fixed.</b> Is it working for you?
          </Text>
          <div className={cs.actions}>
            <Button appearance="primary" disabled={move.isPending} onClick={() => move.mutate('closed')}>
              Yes, it&apos;s fixed
            </Button>
          </div>
        </div>
      )}

      {staff && data.agent && <IncidentAssistantCard base={base} incidentId={id} agent={data.agent} assignedAgentName={r.assigned_agent_name ?? null} onChanged={refresh} />}

      {staff && <KnowledgeSuggestions base={base} incidentId={id} />}

      {staff && ['restored', 'resolved', 'closed'].includes(r.status) && <SaveKnowledgeButton base={base} incidentId={id} />}

      {staff && <IncidentChecks base={base} incidentId={id} />}

      {staff && !['resolved', 'closed', 'cancelled', 'duplicate'].includes(r.status) && <AskAssistantCard base={base} incidentId={id} onChanged={refresh} />}

      <IncidentMajorSection base={base} incident={r} major={data.major} children={data.children} parent={data.parent} staff={staff} onChanged={refresh} />

      <Card className={ps.card}>
        <div className={cs.facts}>
          <Text className={cs.factLabel}>Status</Text>
          <span>
            <IncStatusBadge status={r.status} hold={r.hold_reason} staff={staff} />
          </span>
          <Text className={cs.factLabel}>Priority</Text>
          <span>
            <PriorityBadge priority={r.priority} staff={staff} />
            {staff && r.priority_overridden && (
              <Text size={200} className={ps.muted}>
                {' '}
                set by the team
              </Text>
            )}
          </span>
          <Text className={cs.factLabel}>First response</Text>
          <span>
            <IncSlaBadge clock={data.sla.response} />{' '}
            <Text size={200} className={ps.muted}>
              target {targetText(target.responseMinutes, data.sla.cover)}
            </Text>
          </span>
          <Text className={cs.factLabel}>Service restored</Text>
          <span>
            <IncSlaBadge clock={data.sla.restoration} />{' '}
            <Text size={200} className={ps.muted}>
              target {hoursText(target.restoreHours, data.sla.cover)}
            </Text>
          </span>
          <Text className={cs.factLabel}>Resolved</Text>
          <span>
            <IncSlaBadge clock={data.sla.resolution} />{' '}
            <Text size={200} className={ps.muted}>
              target {hoursText(target.resolveHours, data.sla.cover)}
            </Text>
          </span>
          <Text className={cs.factLabel}>Impact</Text>
          <Text>{INC_IMPACT_LABELS[r.impact]}</Text>
          <Text className={cs.factLabel}>Effect</Text>
          <Text>{INC_URGENCY_LABELS[r.urgency]}</Text>
          <Text className={cs.factLabel}>Raised by</Text>
          <Text>
            {r.reporter_name ?? '—'} · {when(r.created_at)}
          </Text>
          {r.details.contact_phone && (
            <>
              <Text className={cs.factLabel}>Contact number</Text>
              <Text>{r.details.contact_phone}</Text>
            </>
          )}
          <Text className={cs.factLabel}>Assigned to</Text>
          {staff && live ? (
            <Select
              size="small"
              value={r.assigned_agent_id ? `a:${r.assigned_agent_id}` : r.assigned_to ? `u:${r.assigned_to}` : ''}
              disabled={assign.isPending}
              onChange={(_, d) => assign.mutate(d.value.startsWith('a:') ? { agentId: d.value.slice(2) } : { userId: d.value.startsWith('u:') ? d.value.slice(2) : null })}
            >
              <option value="">Unassigned</option>
              <optgroup label="People">
                {(assignees.data ?? []).map((a) => (
                  <option key={a.id} value={`u:${a.id}`}>
                    {a.display_name}
                  </option>
                ))}
              </optgroup>
              {(assistants.data ?? []).length > 0 && (
                <optgroup label="Assistants (AI)">
                  {assistants.data!.map((a) => (
                    <option key={a.id} value={`a:${a.id}`}>
                      {agentLabel(a.name)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          ) : (
            <Text>{r.assigned_agent_name ?? r.assigned_to_name ?? 'Not yet assigned'}</Text>
          )}
          <Text className={cs.factLabel}>Following</Text>
          <span className={cs.actions}>
            {staff && data.watchers ? (
              <Text>{data.watchers.length ? data.watchers.map((w) => w.display_name).join(', ') : 'Nobody else'}</Text>
            ) : (
              <>
                <Text>{r.reporter_id === me?.id ? 'You raised this, so you get every update' : data.watching ? 'You get every update' : ''}</Text>
                {live && r.reporter_id !== me?.id && (
                  <Button size="small" disabled={watch.isPending} onClick={() => watch.mutate(!data.watching)}>
                    {data.watching ? 'Stop following' : 'Follow this incident'}
                  </Button>
                )}
              </>
            )}
          </span>
        </div>

        <div className={cs.section}>
          <Text weight="semibold">What was reported</Text>
          <Text className={ls.preWrap}>{r.description}</Text>
          {lines.length > 0 && (
            <div className={cs.facts}>
              {lines.map((l) => (
                <FactRow key={l.label} label={l.label} value={l.value} />
              ))}
            </div>
          )}
        </div>

        {(r.details.example_calls ?? []).length > 0 && (
          <div className={cs.section}>
            <Text weight="semibold">Example calls</Text>
            <DataTable size="small" minWidth={640}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>When</TableHeaderCell>
                  <TableHeaderCell>Direction</TableHeaderCell>
                  <TableHeaderCell>From</TableHeaderCell>
                  <TableHeaderCell>To</TableHeaderCell>
                  <TableHeaderCell>What happened</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.details.example_calls.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell>{c.at}</TableCell>
                    <TableCell>{c.direction}</TableCell>
                    <TableCell>{c.from ?? '—'}</TableCell>
                    <TableCell>{c.to ?? '—'}</TableCell>
                    <TableCell>{c.note ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          </div>
        )}

        {(data.items.length > 0 || staff) && (
          <div className={cs.section}>
            <Text weight="semibold">{staff ? 'Affected and linked items' : 'Affected'}</Text>
            {data.items.length === 0 ? (
              <Text size={200} className={ps.muted}>
                Nothing linked yet.
              </Text>
            ) : (
              <ul className={ls.pl20Margin0}>
                {data.items.map((i) => (
                  <li key={i.id}>
                    <Text size={200} className={ps.muted}>
                      {ITEM_LABEL[i.kind]}:{' '}
                    </Text>
                    {i.label ?? i.ref}
                    {i.label && i.label !== i.ref ? <Text size={200} className={ps.muted}> ({i.ref})</Text> : null}
                    {staff && (
                      <Button size="small" appearance="subtle" icon={<DeleteRegular />} aria-label="Remove" disabled={removeItem.isPending} onClick={() => removeItem.mutate(i.id)} />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {staff && (
              <div className={ps.twoCol}>
                <Field label="Link something">
                  <Input value={itemRef} placeholder="Sign-in address, number, queue name, SR-0042 ..." onChange={(_, d) => setItemRef(d.value)} />
                </Field>
                <Field label="Type">
                  <Select value={itemKind} onChange={(_, d) => setItemKind(d.value as IncItemKind)}>
                    {INC_ITEM_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {ITEM_LABEL[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button disabled={!itemRef.trim() || addItem.isPending} onClick={() => addItem.mutate()}>
                  Link
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {showActions && (
        <Card className={ps.card}>
          <Text weight="semibold">{staff ? 'Work this incident' : data.can.confirmFixed ? 'Not fixed?' : 'Update this incident'}</Text>
          {!staff && data.can.reopen && (
            <Text size={200} className={ps.muted}>
              If it is still broken, say what is wrong. You can reopen it for {INC_REOPEN_DAYS} days after it was resolved.
            </Text>
          )}
          {(staff || canReopen) && (
            <Field hint={staff ? 'Shown to the customer when you restore or resolve. Needed to restore, resolve, reopen, cancel or mark a duplicate.' : undefined}>
              <Textarea value={note} maxLength={4000} placeholder={staff ? 'Add a note' : "What's still wrong?"} resize="vertical" onChange={(_, d) => setNote(d.value)} />
            </Field>
          )}
          {staff && (kindTo('on_hold') || kindTo('duplicate')) && (
            <div className={ps.pair}>
          {kindTo('on_hold') && (
            <Field label="If you put it on hold, waiting on">
              <Select value={holdReason} onChange={(_, d) => setHoldReason(d.value as IncHoldReason | '')}>
                <option value="">Choose…</option>
                {INC_HOLD_REASONS.map((h) => (
                  <option key={h} value={h}>
                    {INC_HOLD_LABELS[h]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {kindTo('duplicate') && (
            <Field label="If it is a duplicate, of">
              <Select value={duplicateOf} onChange={(_, d) => setDuplicateOf(d.value)}>
                <option value="">Choose an incident…</option>
                {(others.data ?? [])
                  .filter((o) => o.id !== id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.reference} · {o.title}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
            </div>
          )}
          {staff && data.major?.active && data.children.some((c) => ['new', 'in_progress', 'on_hold', 'restored'].includes(c.status)) && kindTo('resolved') && (
            <Checkbox checked={resolveChildren} onChange={(_, d) => setResolveChildren(!!d.checked)} label={`When I mark it resolved, resolve its ${data.children.filter((c) => ['new', 'in_progress', 'on_hold', 'restored'].includes(c.status)).length} open linked incident(s) too, with the same note`} />
          )}
          <div className={cs.actions}>
            {staffMoves.map(([to, appearance]) => {
              const k = kindTo(to as IncStatus)!;
              if (k === 'reopen') return null;
              return (
                <Button key={to} appearance={appearance} disabled={move.isPending || (needsNote(to as IncStatus) && noteMissing)} onClick={() => move.mutate(to as IncStatus)}>
                  {MOVE_LABEL[k]}
                </Button>
              );
            })}
            {staff && kindTo('on_hold') && (
              <Button disabled={move.isPending || !holdReason} onClick={() => move.mutate('on_hold')}>
                {MOVE_LABEL.hold}
              </Button>
            )}
            {canReopen && (
              <Button appearance={staff ? 'secondary' : 'primary'} disabled={move.isPending || noteMissing} onClick={() => move.mutate('in_progress')}>
                {staff ? 'Reopen' : 'Still broken'}
              </Button>
            )}
            {staff && kindTo('duplicate') && (
              <Button disabled={move.isPending || !duplicateOf || noteMissing} onClick={() => move.mutate('duplicate')}>
                {MOVE_LABEL.duplicate}
              </Button>
            )}
            {(staff ? kindTo('cancelled') : data.can.cancel) && (
              <Button disabled={move.isPending || (staff && noteMissing)} onClick={() => move.mutate('cancelled')}>
                {MOVE_LABEL.cancel}
              </Button>
            )}
          </div>
          {staff && live && (
            <div className={mergeClasses(ps.twoCol, ls.styled)}>
              <Field label="Change priority">
                <Select value={newPriority} onChange={(_, d) => setNewPriority(d.value as IncPriority | '')}>
                  <option value="">Choose…</option>
                  {INC_PRIORITIES.filter((p) => p !== r.priority).map((p) => (
                    <option key={p} value={p}>
                      {INC_PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Why (the customer isn't shown this)">
                <Input value={priorityReason} maxLength={1000} onChange={(_, d) => setPriorityReason(d.value)} />
              </Field>
              <Button disabled={!newPriority || priorityReason.trim().length < 3 || setPriority.isPending} onClick={() => setPriority.mutate()}>
                Change priority
              </Button>
            </div>
          )}
        </Card>
      )}

      {staff && <IncidentProblemCard base={base} incident={{ id, title: r.title, category: r.category, subcategory: r.subcategory }} problem={data.problem} onChanged={refresh} />}

      <IncidentReviewCard base={base} incident={{ id, reference: r.reference }} review={data.review} staff={staff} show={!!data.major || ['resolved', 'closed'].includes(r.status)} />

      <Attachments base={base} id={id} />

      <Card className={ps.card}>
        <Text weight="semibold">Timeline</Text>
        {data.events.map((e) => (
          <div key={e.id} className={`${cs.event} ${e.internal ? cs.internal : ''}`}>
            <Text size={200}>
              <b>{e.actor_type === 'agent' ? `${e.author_name ?? 'Assistant'} (AI)` : (e.author_name ?? 'Someone')}</b> · {when(e.created_at)}
              {e.internal ? ' · internal note' : ''}
            </Text>
            <Text className={ls.preWrap}>{eventText(e, staff)}</Text>
          </div>
        ))}
        {can('inc:create') && (r.status !== 'closed' || staff) && (
          <div className={cs.section}>
            <Field label="Add a comment">
              <Textarea value={comment} maxLength={4000} resize="vertical" onChange={(_, d) => setComment(d.value)} />
            </Field>
            {staff && (
              <RadioGroup layout="horizontal" value={commentKind} onChange={(_, d) => setCommentKind(d.value as typeof commentKind)}>
                <Radio value="public" label="Update the customer" />
                <Radio value="question" label="Ask the customer and wait for their reply" disabled={!['new', 'in_progress', 'restored', 'on_hold'].includes(r.status)} />
                <Radio value="internal" label="Internal note (the customer won't see it)" />
              </RadioGroup>
            )}
            <div className={cs.actions}>
              <Button disabled={!comment.trim() || addComment.isPending} onClick={() => addComment.mutate()}>
                {commentKind === 'question' && staff ? 'Ask and wait' : 'Add comment'}
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
  const ls = useLocalStyles();
  const cs = useSrStyles();
  return (
    <>
      <Text className={cs.factLabel}>{label}</Text>
      <Text className={ls.preWrap}>{value}</Text>
    </>
  );
}

function eventText(e: IncidentEvent, staff: boolean): string {
  const status = (st: string | null) => (st ? ((staff ? INC_STATUS_LABELS : INC_STATUS_CUSTOMER_LABELS) as Record<string, string>)[st] ?? st : '—');
  switch (e.kind) {
    case 'created':
      return 'Raised the incident.';
    case 'status_changed': {
      const k = e.meta?.kind as IncMoveKind | undefined;
      const hold = e.meta?.holdReason as IncHoldReason | undefined;
      const moved =
        k === 'acknowledge'
          ? 'Acknowledged the incident.'
          : k === 'hold'
            ? `Put on hold${hold ? `: ${INC_HOLD_LABELS[hold].toLowerCase()}` : ''}.`
            : k === 'resume'
              ? 'Back to work.'
              : k === 'restore'
                ? 'Service restored.'
                : k === 'resolve'
                  ? 'Marked as resolved.'
                  : k === 'close'
                    ? 'Closed.'
                    : k === 'reopen'
                      ? 'Reopened: still broken.'
                      : k === 'cancel'
                        ? 'Cancelled the incident.'
                        : k === 'duplicate'
                          ? 'Marked as a duplicate of another incident.'
                          : `Moved from ${status(e.from_status)} to ${status(e.to_status)}.`;
      return e.body ? `${moved} ${e.body}` : moved;
    }
    case 'priority_changed': {
      const p = (v: string | null) => (v && v in INC_PRIORITY_LABELS ? INC_PRIORITY_LABELS[v as IncPriority] : '—');
      const moved = `Changed the priority from ${p(e.from_status)} to ${p(e.to_status)}.`;
      return staff && e.body ? `${moved} ${e.body}` : moved;
    }
    case 'waiting':
      return `Asked: ${e.body ?? ''}`;
    case 'resumed':
      return staff ? 'The customer replied; no longer waiting.' : 'Thanks for replying - back to work.';
    case 'attachment':
      return `Attached ${e.body ?? 'a file'}.`;
    case 'assigned':
      return e.body === 'Unassigned' ? 'Unassigned the incident.' : `Assigned to ${e.body}.`;
    case 'link':
      return `Linked ${e.body ?? 'an item'}.`;
    case 'major_declared':
      return `Declared a major incident. ${e.body ?? ''}`.trim();
    case 'major_update':
      return `Update: ${e.body ?? ''}`;
    case 'major_ended':
      return e.body ? `The major incident is over. ${e.body}` : 'The major incident is over.';
    case 'child_linked':
    case 'child_unlinked':
    case 'problem_linked':
      return e.body ?? '';
    case 'review_shared':
      return 'Shared the post-incident review.';
    case 'claim_started':
    case 'claim_released':
    case 'handoff':
    case 'proposal':
    case 'proposal_decided':
    case 'diagnostic':
      return e.body ?? '';
    case 'comment':
      return e.body ?? '';
  }
}

function Attachments({ base, id }: { base: string; id: string }) {
  const ls = useLocalStyles();
  const ps = usePageStyles();
  const cs = useSrStyles();
  const qc = useQueryClient();
  const { can } = useAuth();
  const picker = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ['incident-attachments', base, id], queryFn: () => api<FileRow[]>(`${base}/${id}/attachments`) });
  const upload = useMutation({
    mutationFn: (f: File) => apiUpload(`${base}/${id}/attachments`, f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incident-attachments', base, id] });
      qc.invalidateQueries({ queryKey: ['incident', base, id] });
    },
  });
  return (
    <Card className={ps.card}>
      <div className={mergeClasses(cs.actions, ls.justifySpacebetween)}>
        <Text weight="semibold">Attachments</Text>
        {can('inc:create') && (
          <>
            <input
              ref={picker}
              type="file"
              className={ls.none}
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.pptx,.csv,.txt"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = '';
              }}
            />
            <Button size="small" disabled={upload.isPending} onClick={() => picker.current?.click()}>
              {upload.isPending ? 'Uploading…' : 'Attach a file'}
            </Button>
          </>
        )}
      </div>
      {(list.data ?? []).length === 0 ? (
        <Text size={200} className={ps.muted}>
          No files yet. Screenshots, call traces and logs help - pictures, PDFs, Office documents, CSV and text files up to 10 MB.
        </Text>
      ) : (
        <ul className={ls.pl20Margin0}>
          {list.data!.map((f) => (
            <li key={f.id}>
              <Link onClick={() => apiDownload(`${base}/${id}/attachments/${f.id}`, f.filename)}>{f.filename}</Link>{' '}
              <Text size={200} className={ps.muted}>
                {Math.max(1, Math.round(f.byteSize / 1024))} KB · {new Date(f.createdAt).toLocaleDateString()}
              </Text>
            </li>
          ))}
        </ul>
      )}
      {upload.error && <Text className={cs.error}>{errorText(upload.error, 'Could not attach the file')}</Text>}
    </Card>
  );
}
