import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
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
  Select,
  Text,
  Textarea,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { INC_MAJOR_DEFAULT_INTERVAL, INC_MAJOR_MAX_INTERVAL, INC_MAJOR_MIN_INTERVAL, type IncMajorClock, type IncPriority, type IncStatus } from '@tvmf/shared';
import { api } from '../api';
import { errorText } from '../pages/ServiceRequests';
import { IncStatusBadge, MajorClockBadge, PriorityBadge, type IncidentRow } from './IncidentBits';

/** The major-incident parts of an incident page payload (see IncidentMajorService.details). */
export interface MajorInfo {
  active: boolean;
  declared_at: string | null;
  ended_at: string | null;
  lead_name: string | null;
  comms_name: string | null;
  lead_id?: string | null;
  comms_id?: string | null;
  interval_minutes?: number | null;
  update_clock: IncMajorClock;
}
export interface ChildIncident {
  id: string;
  reference: string;
  title: string;
  status: IncStatus;
  priority: IncPriority;
  sitecode: string | null;
}
export interface ParentIncident {
  id: string;
  reference: string;
  title: string;
  status: IncStatus;
}

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  head: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXS },
  facts: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalXXS },
  muted: { color: tokens.colorNeutralForeground3 },
  major: { ...shorthands.border('1px', 'solid', tokens.colorPaletteRedBorder1) },
  actions: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  error: { color: tokens.colorPaletteRedForeground1 },
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  banner: { ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), ...shorthands.border('1px', 'solid', tokens.colorPaletteRedBorder1), backgroundColor: tokens.colorPaletteRedBackground1 },
});

interface Props {
  base: string;
  incident: { id: string; reference: string; priority: IncPriority; status: IncStatus };
  major: MajorInfo | null;
  children: ChildIncident[];
  parent: ParentIncident | null;
  staff: boolean;
  onChanged: () => void;
}

/**
 * Everything major-incident on an incident page. Engineers can declare one (a lead, a comms owner
 * and a cadence of customer updates), post updates, change the roles and link child incidents;
 * a customer sees that it is a major incident, who is leading, and when we'll next update.
 */
export function IncidentMajorSection({ base, incident, major, children, parent, staff, onChanged }: Props) {
  const s = useStyles();
  const qc = useQueryClient();
  const id = incident.id;
  const open = ['new', 'in_progress', 'on_hold', 'restored'].includes(incident.status);
  const [declaring, setDeclaring] = useState(false);
  const [roles, setRoles] = useState(false);
  const [linking, setLinking] = useState(false);
  const [update, setUpdate] = useState('');
  const [interval, setIntervalMinutes] = useState('');

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['incident', base, id] });
    qc.invalidateQueries({ queryKey: ['incidents'] });
    qc.invalidateQueries({ queryKey: ['msp-incidents'] });
    onChanged();
  };
  const post = useMutation({
    mutationFn: () => api(`${base}/${id}/major/updates`, { method: 'POST', body: JSON.stringify({ body: update, intervalMinutes: interval ? Number(interval) : undefined }) }),
    onSuccess: () => {
      setUpdate('');
      setIntervalMinutes('');
      refresh();
    },
  });
  const unlink = useMutation({ mutationFn: (childId: string) => api(`${base}/${id}/children/${childId}`, { method: 'DELETE' }), onSuccess: refresh });

  const banner = parent && (
    <div className={s.banner}>
      <Text>
        This incident is part of the major incident{' '}
        <RouterLink to={`/incidents/${parent.id}`}>
          {parent.reference} · {parent.title}
        </RouterLink>
        . Updates on that incident cover this one too.
      </Text>
      {staff && (
        <div style={{ marginTop: 6 }}>
          <Button size="small" onClick={() => api(`${base}/${parent.id}/children/${id}`, { method: 'DELETE' }).then(refresh)}>
            Unlink from it
          </Button>
        </div>
      )}
    </div>
  );

  // Customers: only what they need to know.
  if (!staff) {
    if (!major && !parent) return null;
    return (
      <>
        {banner}
        {major?.active && (
          <Card className={`${s.card} ${s.major}`}>
            <div className={s.head}>
              <Badge appearance="filled" color="danger">
                Major incident
              </Badge>
              <MajorClockBadge clock={major.update_clock} />
            </div>
            <Text>
              This is a major incident{major.lead_name ? `, led by ${major.lead_name}` : ''}. We&apos;re posting updates in the timeline below
              {major.update_clock.dueAt ? ` and will update you again by ${new Date(major.update_clock.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.
            </Text>
          </Card>
        )}
        {children.length > 0 && (
          <Card className={s.card}>
            <Text weight="semibold">Incidents covered by this one</Text>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {children.map((c) => (
                <li key={c.id}>
                  {c.reference} · {c.title}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </>
    );
  }

  return (
    <>
      {banner}
      {!major?.active && open && !parent && (
        <Card className={s.card}>
          <div className={s.head}>
            <Text weight="semibold">Major incident</Text>
            {major && (
              <Text size={200} className={s.muted}>
                Was a major incident{major.ended_at ? ` until ${new Date(major.ended_at).toLocaleString()}` : ''}.
              </Text>
            )}
          </div>
          <Text size={200} className={s.muted}>
            A serious problem that needs a named lead, regular updates to the customer, and the incidents it causes grouped under it. Declaring one tells the customer we know about it.
          </Text>
          <div>
            <Button appearance={incident.priority === 'p1' ? 'primary' : 'secondary'} onClick={() => setDeclaring(true)}>
              Declare a major incident
            </Button>
          </div>
        </Card>
      )}

      {major?.active && (
        <Card className={`${s.card} ${s.major}`}>
          <div className={s.head}>
            <Badge appearance="filled" color="danger">
              Major incident
            </Badge>
            <MajorClockBadge clock={major.update_clock} />
            <Text size={200} className={s.muted}>
              declared {major.declared_at ? new Date(major.declared_at).toLocaleString() : ''}
              {major.interval_minutes ? ` · updates every ${major.interval_minutes} min` : ''}
            </Text>
          </div>
          <div className={s.facts}>
            <Text className={s.muted}>Lead</Text>
            <Text>{major.lead_name ?? '—'}</Text>
            <Text className={s.muted}>Comms owner</Text>
            <Text>
              {major.comms_name ?? '—'}{' '}
              <Button size="small" appearance="subtle" onClick={() => setRoles(true)}>
                Change
              </Button>
            </Text>
          </div>
          <Field label="Customer update" hint="Goes to the reporter, followers, the customer's named contacts and the reporters of linked incidents, and starts the clock for the next one.">
            <Textarea value={update} maxLength={4000} rows={3} resize="vertical" onChange={(_, d) => setUpdate(d.value)} />
          </Field>
          <div className={s.actions}>
            <Button appearance="primary" disabled={!update.trim() || post.isPending} onClick={() => post.mutate()}>
              {post.isPending ? 'Posting…' : 'Post update'}
            </Button>
            <Field label="Next update (min)" orientation="horizontal">
              <Input type="number" size="small" style={{ width: 90 }} min={INC_MAJOR_MIN_INTERVAL} max={INC_MAJOR_MAX_INTERVAL} placeholder={String(major.interval_minutes ?? INC_MAJOR_DEFAULT_INTERVAL[incident.priority])} value={interval} onChange={(_, d) => setIntervalMinutes(d.value)} />
            </Field>
          </div>
          {post.error && <Text className={s.error}>{errorText(post.error, 'Could not post the update')}</Text>}

          <div className={s.stack}>
            <div className={s.head}>
              <Text weight="semibold">Linked incidents ({children.length})</Text>
              <Button size="small" onClick={() => setLinking(true)}>
                Link incidents
              </Button>
            </div>
            {children.length === 0 ? (
              <Text size={200} className={s.muted}>
                Nothing linked yet. Incidents raised because of this problem can be grouped under it, so one update reaches all of their reporters.
              </Text>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {children.map((c) => (
                  <li key={c.id}>
                    <RouterLink to={`/incidents/${c.id}`}>{c.reference}</RouterLink> · {c.title}
                    {c.sitecode ? ` (${c.sitecode})` : ''} <PriorityBadge priority={c.priority} /> <IncStatusBadge status={c.status} hold={null} staff />
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} aria-label={`Unlink ${c.reference}`} disabled={unlink.isPending} onClick={() => unlink.mutate(c.id)} />
                  </li>
                ))}
              </ul>
            )}
            {unlink.error && <Text className={s.error}>{errorText(unlink.error, 'Could not unlink it')}</Text>}
          </div>
        </Card>
      )}

      {declaring && <DeclareDialog base={base} incident={incident} onClose={() => setDeclaring(false)} onDone={() => (setDeclaring(false), refresh())} />}
      {roles && major && <RolesDialog base={base} id={id} lead={major.lead_id ?? ''} comms={major.comms_id ?? ''} onClose={() => setRoles(false)} onDone={() => (setRoles(false), refresh())} />}
      {linking && <LinkDialog base={base} id={id} linked={children.map((c) => c.id)} onClose={() => setLinking(false)} onDone={() => (setLinking(false), refresh())} />}
    </>
  );
}

function useStaff(base: string) {
  return useQuery({ queryKey: ['incident-assignees', base], queryFn: () => api<{ id: string; display_name: string }[]>(`${base}/assignees`) });
}

function DeclareDialog({ base, incident, onClose, onDone }: { base: string; incident: { id: string; reference: string; priority: IncPriority }; onClose: () => void; onDone: () => void }) {
  const s = useStyles();
  const { data: staff = [] } = useStaff(base);
  const [leadId, setLeadId] = useState('');
  const [commsId, setCommsId] = useState('');
  const [interval, setIntervalMinutes] = useState('');
  const [summary, setSummary] = useState('');
  const declare = useMutation({
    mutationFn: () => api(`${base}/${incident.id}/major`, { method: 'POST', body: JSON.stringify({ leadId, commsId: commsId || undefined, intervalMinutes: interval ? Number(interval) : undefined, summary }) }),
    onSuccess: onDone,
  });
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '620px' }}>
        <DialogBody>
          <DialogTitle>Declare {incident.reference} a major incident</DialogTitle>
          <DialogContent className={s.stack}>
            <Text size={200}>The customer is told straight away, and the whole team is told who is leading. You can resolve its linked incidents with it later.</Text>
            <Field label="Lead" required hint="Runs the response. Becomes the assignee if nobody has it.">
              <Select value={leadId} onChange={(_, d) => setLeadId(d.value)}>
                <option value="">Choose…</option>
                {staff.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Comms owner" hint="Writes the customer updates. Defaults to the lead.">
              <Select value={commsId} onChange={(_, d) => setCommsId(d.value)}>
                <option value="">Same as the lead</option>
                {staff.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Update the customer every (minutes)" hint={`Default for ${incident.priority.toUpperCase()}: ${INC_MAJOR_DEFAULT_INTERVAL[incident.priority]}. The comms owner is reminded when one is due, and the team when it is late.`}>
              <Input type="number" min={INC_MAJOR_MIN_INTERVAL} max={INC_MAJOR_MAX_INTERVAL} placeholder={String(INC_MAJOR_DEFAULT_INTERVAL[incident.priority])} value={interval} onChange={(_, d) => setIntervalMinutes(d.value)} />
            </Field>
            <Field label="What the customer is told now" required hint="What we know, and what we're doing about it.">
              <Textarea value={summary} maxLength={4000} rows={4} resize="vertical" onChange={(_, d) => setSummary(d.value)} />
            </Field>
            {declare.error && <Text className={s.error}>{errorText(declare.error, 'Could not declare it')}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={!leadId || summary.trim().length < 5 || declare.isPending} onClick={() => declare.mutate()}>
              {declare.isPending ? 'Declaring…' : 'Declare major incident'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function RolesDialog({ base, id, lead, comms, onClose, onDone }: { base: string; id: string; lead: string; comms: string; onClose: () => void; onDone: () => void }) {
  const s = useStyles();
  const { data: staff = [] } = useStaff(base);
  const [leadId, setLeadId] = useState(lead);
  const [commsId, setCommsId] = useState(comms);
  const save = useMutation({
    mutationFn: () => api(`${base}/${id}/major`, { method: 'PATCH', body: JSON.stringify({ leadId: leadId !== lead ? leadId : undefined, commsId: commsId !== comms ? commsId : undefined }) }),
    onSuccess: onDone,
  });
  const opts = staff.map((m) => (
    <option key={m.id} value={m.id}>
      {m.display_name}
    </option>
  ));
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '480px' }}>
        <DialogBody>
          <DialogTitle>Lead and comms owner</DialogTitle>
          <DialogContent className={s.stack}>
            <Field label="Lead">
              <Select value={leadId} onChange={(_, d) => setLeadId(d.value)}>
                {opts}
              </Select>
            </Field>
            <Field label="Comms owner">
              <Select value={commsId} onChange={(_, d) => setCommsId(d.value)}>
                {opts}
              </Select>
            </Field>
            {save.error && <Text className={s.error}>{errorText(save.error, 'Could not change them')}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={(leadId === lead && commsId === comms) || save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function LinkDialog({ base, id, linked, onClose, onDone }: { base: string; id: string; linked: string[]; onClose: () => void; onDone: () => void }) {
  const s = useStyles();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const list = useQuery({ queryKey: ['incident-link-candidates', base], queryFn: () => api<IncidentRow[]>(`${base}?status=open&limit=500`) });
  const candidates = (list.data ?? []).filter((i) => i.id !== id && !linked.includes(i.id) && !i.major && ['new', 'in_progress', 'on_hold', 'restored'].includes(i.status));
  const link = useMutation({ mutationFn: () => api(`${base}/${id}/children`, { method: 'POST', body: JSON.stringify({ childIds: [...picked] }) }), onSuccess: onDone });
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '640px' }}>
        <DialogBody>
          <DialogTitle>Link incidents under this one</DialogTitle>
          <DialogContent className={s.stack} style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            <Text size={200}>Pick the open incidents caused by this problem. Their reporters then get this incident&apos;s updates, and you can resolve them together.</Text>
            {list.isLoading ? <Text>Loading…</Text> : candidates.length === 0 ? <Text>No other open incidents to link.</Text> : null}
            {candidates.map((i) => (
              <Checkbox
                key={i.id}
                checked={picked.has(i.id)}
                label={`${i.reference} · ${i.title}${i.sitecode ? ` (${i.sitecode})` : ''}`}
                onChange={(_, d) =>
                  setPicked((prev) => {
                    const n = new Set(prev);
                    if (d.checked) n.add(i.id);
                    else n.delete(i.id);
                    return n;
                  })
                }
              />
            ))}
            {link.error && <Text className={s.error}>{errorText(link.error, 'Could not link them')}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={picked.size === 0 || link.isPending} onClick={() => link.mutate()}>
              Link {picked.size || ''} incident{picked.size === 1 ? '' : 's'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
