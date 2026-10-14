import { useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RequestAssistantCard } from '../../components/RequestAssistant';
import { agentLabel } from '@tvmf/shared';
import { Badge, Button, Card, Field, Radio, RadioGroup, Link, Select, Text, Textarea, tokens } from '@fluentui/react-components';
import { SR_NOTE_REQUIRED, SR_REOPEN_DAYS, canMoveSr, nextSrStatus, srCanReopen, srMoveKind, srStatusLabel, srDetailLines, type FileRow, type SrDesignSummary, type SrStatus } from '@tvmf/shared';
import { api, apiDownload, apiUpload } from '../../api';
import { useAuth } from '../../auth';
import { SlaBadge } from '../../components/SrTarget';
import { hoursText } from '../ServiceRequestAdmin';
import { PRIORITY_LABEL, STATUS_COLOR, day, errorText, useSrStyles, when, type RequestEvent } from '../ServiceRequests';
import { usePageStyles, type PageTab, type RequestPayload } from './srShared';
import { BuildDraftSection, BuildLinks } from './srDesign';
import { ApprovalBanner } from './srDeploy';
import { DangerText } from '../../components/ui';

export function Overview({
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
  const agents = useQuery({
    queryKey: ['sr-agents', base],
    enabled: canManage,
    queryFn: () => api<{ id: string; name: string }[]>(`${base}/agents`),
  });
  const assign = useMutation({
    // "u:<id>" a person, "a:<id>" an assistant, "" nobody.
    mutationFn: (who: string) => api(`${base}/${id}/assign`, { method: 'POST', body: JSON.stringify(who.startsWith('a:') ? { agentId: who.slice(2) } : { userId: who.startsWith('u:') ? who.slice(2) : null }) }),
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
      {data.approval && <ApprovalBanner base={base} id={id} approval={data.approval} onDone={refresh} />}
      {data.checks.length > 0 && (
        <div className={ps.waiting}>
          <div>
            <Text weight="semibold">Worth checking</Text>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {data.checks.map((c) => (
                <li key={c}>
                  <Text size={200}>{c}</Text>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
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
      {canManage && data.agent && <RequestAssistantCard base={base} requestId={id} status={r.status} agent={data.agent} assignedAgentName={r.assigned_agent_name ?? null} onChanged={refresh} />}
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
            <Select size="small" value={r.assigned_agent_id ? `a:${r.assigned_agent_id}` : r.assigned_to ? `u:${r.assigned_to}` : ''} disabled={assign.isPending} onChange={(_, d) => assign.mutate(d.value)}>
              <option value="">Unassigned</option>
              {(assignees.data ?? []).map((a) => (
                <option key={a.id} value={`u:${a.id}`}>
                  {a.display_name}
                </option>
              ))}
              {(agents.data ?? []).length > 0 && (
                <optgroup label="Assistants (AI)">
                  {(agents.data ?? []).map((a) => (
                    <option key={a.id} value={`a:${a.id}`}>
                      {agentLabel(a.name)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          ) : (
            <Text>{r.assigned_agent_name ?? r.assigned_to_name ?? 'Unassigned'}</Text>
          )}
        </div>

        {canManage && <RelatedIncidents base={base} requestId={id} incidents={data.incidents ?? []} onChanged={refresh} />}

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

      <Attachments base={base} id={id} />

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
    case 'approval':
      return e.body ?? '';
    case 'attachment':
      return `Attached ${e.body ?? 'a file'}.`;
    case 'assigned':
      return e.body === 'Unassigned' ? 'Unassigned the request.' : `Assigned to ${e.body}.`;
    case 'comment':
    case 'build_drafted':
    case 'deployment':
    case 'claim_started':
    case 'claim_released':
    case 'handoff':
    case 'proposal':
    case 'proposal_decided':
    case 'whatif':
      return e.body ?? '';
  }
}

/* --------------------------------- design --------------------------------- */

function Attachments({ base, id }: { base: string; id: string }) {
  const ps = usePageStyles();
  const cs = useSrStyles();
  const qc = useQueryClient();
  const { can } = useAuth();
  const picker = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ['sr-attachments', base, id], queryFn: () => api<FileRow[]>(`${base}/${id}/attachments`) });
  const upload = useMutation({
    mutationFn: (f: File) => apiUpload(`${base}/${id}/attachments`, f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sr-attachments', base, id] });
      qc.invalidateQueries({ queryKey: ['service-request', base, id] });
    },
  });
  return (
    <Card className={ps.card}>
      <div className={cs.actions} style={{ justifyContent: 'space-between' }}>
        <Text weight="semibold">Attachments</Text>
        {can('sr:create') && (
          <>
            <input
              ref={picker}
              type="file"
              style={{ display: 'none' }}
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
          No files yet. Pictures, PDFs, Office documents, CSV and text files up to 10 MB.
        </Text>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
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

/* --------------------------- new phone numbers --------------------------- */

/** Incidents this request is linked to (staff): "the fix for INC-0042 is this request". The incident lists the request among its items too. */
function RelatedIncidents({ base, requestId, incidents, onChanged }: { base: string; requestId: string; incidents: { id: string; reference: string; title: string; status: string; priority: string }[]; onChanged: () => void }) {
  const { activeTenantId } = useAuth();
  const qc = useQueryClient();
  const [pick, setPick] = useState('');
  const open = useQuery({
    queryKey: ['incidents', 'open-for-link', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<{ id: string; reference: string; title: string }[]>(`/t/${activeTenantId}/incidents?status=open`),
  });
  const link = useMutation({
    mutationFn: (incidentId: string | null) => api(`${base}/${requestId}/incident`, { method: 'POST', body: JSON.stringify({ incidentId }) }),
    onSuccess: () => {
      setPick('');
      qc.invalidateQueries({ queryKey: ['service-request', base, requestId] });
      qc.invalidateQueries({ queryKey: ['incident'] });
      onChanged();
    },
  });
  const candidates = (open.data ?? []).filter((i) => !incidents.some((x) => x.id === i.id));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', rowGap: 6 }}>
      <Text weight="semibold">Related incidents</Text>
      {incidents.length === 0 && <Text size={200}>None linked.</Text>}
      {incidents.map((i) => (
        <div key={i.id} style={{ display: 'flex', columnGap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <RouterLink to={`/incidents/${i.id}`}>
            {i.reference} · {i.title}
          </RouterLink>
          <Badge appearance="tint">{i.status.replace('_', ' ')}</Badge>
          <Button size="small" disabled={link.isPending} onClick={() => link.mutate(null)}>
            Unlink
          </Button>
        </div>
      ))}
      {candidates.length > 0 && (
        <div style={{ display: 'flex', columnGap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Select size="small" value={pick} onChange={(_, d) => setPick(d.value)} aria-label="Link an incident">
            <option value="">Link an incident…</option>
            {candidates.map((i) => (
              <option key={i.id} value={i.id}>
                {i.reference} · {i.title}
              </option>
            ))}
          </Select>
          <Button size="small" disabled={!pick || link.isPending} onClick={() => link.mutate(pick)}>
            Link
          </Button>
        </div>
      )}
      {link.error && <DangerText>{errorText(link.error, 'Could not link it.')}</DangerText>}
    </div>
  );
}
