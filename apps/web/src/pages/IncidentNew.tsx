import { useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Checkbox, Field, Input, Link, Radio, RadioGroup, Select, Text, Textarea, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ArrowLeftRegular, DeleteRegular, WarningRegular } from '@fluentui/react-icons';
import {
  INC_CALL_DIRECTIONS,
  INC_CATEGORIES,
  INC_CATEGORY_BY_KEY,
  INC_IMPACTS,
  INC_IMPACT_LABELS,
  INC_PRIORITIES,
  INC_PRIORITY_CUSTOMER_TEXT,
  INC_PRIORITY_LABELS,
  INC_URGENCIES,
  INC_URGENCY_LABELS,
  createIncidentSchema,
  incPriority,
  type IncExampleCall,
  type IncImpact,
  type IncMatrix,
  type IncPriority,
  type IncUrgency,
  type SrFieldSpec,
} from '@tvmf/shared';
import { api, apiUpload } from '../api';
import { useAuth } from '../auth';
import { KnowledgeTips } from '../components/IncidentKnowledge';
import { Page } from '../components/Page';
import { NoTenant } from '../components/records';
import { errorText, useSrStyles } from './ServiceRequests';

const useStyles = makeStyles({
  cats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalM },
  cat: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
    textAlign: 'left',
    cursor: 'pointer',
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  catOn: { ...shorthands.border('2px', 'solid', tokens.colorBrandStroke1), backgroundColor: tokens.colorBrandBackground2 },
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3 },
  call: { display: 'grid', gridTemplateColumns: 'minmax(150px, 1.2fr) 130px 1fr 1fr 1.4fr auto', columnGap: tokens.spacingHorizontalS, alignItems: 'end' },
  emergency: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalS,
    alignItems: 'flex-start',
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorPaletteRedBorder1),
    backgroundColor: tokens.colorPaletteRedBackground1,
  },
  notice: {
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorPaletteYellowBorder1),
    backgroundColor: tokens.colorPaletteYellowBackground1,
  },
  missing: { margin: 0, paddingLeft: '20px', color: tokens.colorNeutralForeground2 },
});

interface SiteOption {
  id: string;
  sitecode: string;
  name: string | null;
  mode: 'project' | 'operations';
}
interface SimilarIncident {
  id: string;
  reference: string;
  title: string;
  status: string;
  priority: IncPriority;
  sitecode: string | null;
  created_at: string;
  following: boolean;
}
interface CallRow extends Partial<IncExampleCall> {
  key: number;
}

/** One of a category's own questions. Incident questions only use text, long text, a pick-list, yes/no and ticks. */
function QuestionInput({ spec, value, onChange }: { spec: SrFieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  switch (spec.kind) {
    case 'textarea':
      return <Textarea value={(value as string) ?? ''} maxLength={spec.max} resize="vertical" onChange={(_, d) => onChange(d.value)} />;
    case 'select':
      return (
        <Select value={(value as string) ?? ''} onChange={(_, d) => onChange(d.value || undefined)}>
          <option value="">Choose…</option>
          {(spec.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case 'boolean':
      return (
        <RadioGroup layout="horizontal" value={value === true ? 'yes' : value === false ? 'no' : ''} onChange={(_, d) => onChange(d.value === 'yes')}>
          <Radio value="yes" label="Yes" />
          <Radio value="no" label="No" />
        </RadioGroup>
      );
    case 'choices': {
      const picked = (value as string[]) ?? [];
      return (
        <div>
          {(spec.options ?? []).map((o) => (
            <Checkbox
              key={o}
              label={o}
              checked={picked.includes(o)}
              onChange={(_, d) => onChange(d.checked ? [...picked, o] : picked.filter((p) => p !== o))}
            />
          ))}
        </div>
      );
    }
    default:
      return <Input value={(value as string) ?? ''} maxLength={spec.max} onChange={(_, d) => onChange(d.value)} />;
  }
}

/** The guided "raise an incident" form: what's wrong, where, who's affected, details, example calls. */
export function IncidentNew() {
  const { activeTenantId, can, me } = useAuth();
  const s = useStyles();
  const cs = useSrStyles();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const staff = can('inc:manage');
  const enabled = me?.tenants.find((t) => t.id === activeTenantId)?.managedServices ?? false;
  const base = `/t/${activeTenantId}/incidents`;
  const picker = useRef<HTMLInputElement>(null);

  const [category, setCategory] = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [siteId, setSiteId] = useState('');
  const [impact, setImpact] = useState<IncImpact | ''>('');
  const [urgency, setUrgency] = useState<IncUrgency | ''>('');
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [priorityOverride, setPriorityOverride] = useState<IncPriority | ''>('');
  const [files, setFiles] = useState<File[]>([]);
  const [followed, setFollowed] = useState<Set<string>>(new Set());

  const def = category ? INC_CATEGORY_BY_KEY[category] : undefined;

  const sitesQ = useQuery({ queryKey: ['incident-sites', activeTenantId], enabled: !!activeTenantId && enabled, queryFn: () => api<SiteOption[]>(`${base}/sites`) });
  const settingsQ = useQuery({ queryKey: ['incident-settings', activeTenantId], enabled: !!activeTenantId && enabled, queryFn: () => api<{ matrix: IncMatrix }>(`${base}/settings`) });
  const similarQ = useQuery({
    queryKey: ['incident-similar', activeTenantId, category, siteId],
    enabled: !!activeTenantId && enabled && !!category,
    queryFn: () => api<SimilarIncident[]>(`${base}/similar?category=${category}${siteId ? `&siteId=${siteId}` : ''}`),
  });
  const knownQ = useQuery({
    queryKey: ['incident-known-errors', activeTenantId, category, subcategory],
    enabled: !!activeTenantId && enabled && !!category,
    queryFn: () => api<{ id: string; reference: string; title: string; customer_note?: string; workaround?: string }[]>(`${base}/known-errors?category=${category}${subcategory ? `&subcategory=${subcategory}` : ''}`),
  });
  const follow = useMutation({
    mutationFn: (id: string) => api(`${base}/${id}/watchers`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (_, id) => setFollowed((prev) => new Set(prev).add(id)),
  });

  const sites = sitesQ.data ?? [];
  const operational = sites.filter((x) => x.mode === 'operations');

  const chooseCategory = (key: string) => {
    setCategory(key);
    setSubcategory('');
    setAnswers({});
    if (!titleTouched) setTitle('');
  };
  const chooseSub = (key: string) => {
    setSubcategory(key);
    const label = def?.subcategories.find((x) => x.key === key)?.label;
    if (!titleTouched && label) setTitle(label);
  };

  const calculated = useMemo(
    () => (impact && urgency ? incPriority(impact, urgency, category || null, settingsQ.data?.matrix) : null),
    [impact, urgency, category, settingsQ.data],
  );
  const priority = priorityOverride || calculated?.priority;

  const payload = useMemo(() => {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(answers)) {
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      cleaned[k] = v;
    }
    const exampleCalls = calls
      .filter((c) => c.at || c.from || c.to || c.note)
      .map((c) => ({ at: c.at ?? '', direction: c.direction ?? 'unknown', from: c.from || undefined, to: c.to || undefined, note: c.note || undefined }));
    return {
      title,
      category,
      subcategory: def && def.subcategories.length > 0 ? subcategory || undefined : undefined,
      siteId: siteId || null,
      impact,
      urgency,
      description,
      answers: cleaned,
      exampleCalls,
      contactPhone: contactPhone || undefined,
      priority: staff && priorityOverride ? priorityOverride : undefined,
    };
  }, [answers, calls, title, category, def, subcategory, siteId, impact, urgency, description, contactPhone, staff, priorityOverride]);

  // The same rules the API checks with: it tells us what's still missing.
  const parsed = useMemo(() => createIncidentSchema.safeParse(payload), [payload]);
  const missing = useMemo(() => {
    if (parsed.success) return [];
    const out: string[] = [];
    for (const i of parsed.error.issues) {
      const m = i.path[0] === 'impact' || i.path[0] === 'urgency' ? (i.path[0] === 'impact' ? 'Say who is affected' : 'Say what they cannot do') : i.path[0] === 'category' ? 'Choose what is wrong' : i.message;
      if (!out.includes(m)) out.push(m);
    }
    return out;
  }, [parsed]);

  const create = useMutation({
    mutationFn: async () => {
      const r = await api<{ id: string }>(base, { method: 'POST', body: JSON.stringify(parsed.success ? parsed.data : payload) });
      // Files are attached once the incident exists; one failing must not lose the incident.
      await Promise.allSettled(files.map((f) => apiUpload(`${base}/${r.id}/attachments`, f)));
      return r;
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['incidents'] });
      navigate(`/incidents/${r.id}`);
    },
  });

  if (!activeTenantId) return <NoTenant />;
  if (!enabled) {
    return (
      <Page title="Raise an incident">
        <Card>
          <Text>
            Managed Services isn&apos;t switched on for this customer. A Super Admin can switch it on from <b>Customers</b>.
          </Text>
        </Card>
      </Page>
    );
  }

  const setCall = (key: number, patch: Partial<CallRow>) => setCalls((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  return (
    <Page
      title="Raise an incident"
      subtitle="Tell us what's wrong. The more detail you give, the faster we can find it - example calls help most."
      actions={
        <RouterLink to="/incidents">
          <Button appearance="subtle" icon={<ArrowLeftRegular />}>
            All incidents
          </Button>
        </RouterLink>
      }
    >
      <Card className={s.card}>
        <Text weight="semibold">1. What is wrong?</Text>
        <div className={s.cats} role="radiogroup" aria-label="What is wrong">
          {INC_CATEGORIES.map((c) => (
            <button key={c.key} type="button" role="radio" aria-checked={category === c.key} className={`${s.cat} ${category === c.key ? s.catOn : ''}`} onClick={() => chooseCategory(c.key)}>
              <Text weight="semibold">{c.label}</Text>
              <Text size={200} className={s.muted}>
                {c.help}
              </Text>
            </button>
          ))}
        </div>
        {def && def.subcategories.length > 0 && (
          <Field label="More specifically" required>
            <Select value={subcategory} onChange={(_, d) => chooseSub(d.value)}>
              <option value="">Choose…</option>
              {def.subcategories.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {def?.warning && (
          <div className={s.emergency} role="alert">
            <WarningRegular fontSize={24} />
            <div>
              <Text weight="semibold" block>
                {def.warning}
              </Text>
              <Text size={200}>Emergency calling problems are always treated as critical, whatever you choose below.</Text>
            </div>
          </div>
        )}
      </Card>

      {def && (
        <>
          {!staff && <KnowledgeTips base={base} category={category} subcategory={subcategory} text={`${title} ${description}`} enabled={enabled} />}

          {(knownQ.data ?? []).length > 0 && (
            <div className={s.notice}>
              <Text weight="semibold" block>
                {staff ? 'Known errors for this kind of incident' : 'Known issue'}
              </Text>
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {knownQ.data!.map((k) => (
                  <li key={k.id}>
                    {staff ? (
                      <>
                        {k.reference} · {k.title}: <Text style={{ whiteSpace: 'pre-wrap' }}>{k.workaround}</Text>
                      </>
                    ) : (
                      <Text style={{ whiteSpace: 'pre-wrap' }}>{k.customer_note}</Text>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(similarQ.data ?? []).length > 0 && (
            <div className={s.notice}>
              <Text weight="semibold" block>
                We&apos;re already working on something like this
              </Text>
              <Text size={200} block>
                If one of these is your problem, follow it instead and you&apos;ll get every update. Otherwise carry on below.
              </Text>
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {similarQ.data!.map((i) => (
                  <li key={i.id}>
                    <Link href={`/incidents/${i.id}`} target="_blank">
                      {i.reference}
                    </Link>{' '}
                    {i.title}
                    {i.sitecode ? ` (${i.sitecode})` : ' (all sites)'} ·{' '}
                    {i.following || followed.has(i.id) ? (
                      <Text size={200}>you&apos;re following it</Text>
                    ) : (
                      <Link onClick={() => follow.mutate(i.id)}>Follow it</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Card className={s.card}>
            <Text weight="semibold">2. Where, and who is affected?</Text>
            <Field
              label="Site"
              required={def.siteRequired}
              hint={
                operational.length === 0
                  ? 'None of your sites are in operations mode yet, so incidents for a site are not open.'
                  : def.siteRequired
                    ? 'The site the problem is at (for someone working remotely, their usual site).'
                    : 'Leave blank if it affects the whole company.'
              }
            >
              <Select value={siteId} onChange={(_, d) => setSiteId(d.value)}>
                <option value="">{def.siteRequired ? 'Choose a site…' : 'Whole company / not site-specific'}</option>
                {sites.map((x) => (
                  <option key={x.id} value={x.id} disabled={x.mode !== 'operations'}>
                    {x.name ? `${x.sitecode} — ${x.name}` : x.sitecode}
                    {x.mode !== 'operations' ? ' (project mode)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Who is affected?" required>
              <RadioGroup value={impact} onChange={(_, d) => setImpact(d.value as IncImpact)}>
                {INC_IMPACTS.map((i) => (
                  <Radio key={i} value={i} label={INC_IMPACT_LABELS[i]} />
                ))}
              </RadioGroup>
            </Field>
            <Field label="What can't they do?" required>
              <RadioGroup value={urgency} onChange={(_, d) => setUrgency(d.value as IncUrgency)}>
                {INC_URGENCIES.map((u) => (
                  <Radio key={u} value={u} label={INC_URGENCY_LABELS[u]} />
                ))}
              </RadioGroup>
            </Field>
            {priority && (
              <Text>
                We&apos;ll treat this as <b>{INC_PRIORITY_CUSTOMER_TEXT[priority]} priority</b>
                {staff ? ` (${INC_PRIORITY_LABELS[priority]})` : ''}.
              </Text>
            )}
            {staff && (
              <Field label="Set the priority yourself (team only)" hint="Leave as calculated unless there's a reason. The customer isn't shown why.">
                <Select value={priorityOverride} onChange={(_, d) => setPriorityOverride(d.value as IncPriority | '')}>
                  <option value="">Calculated from impact and urgency</option>
                  {INC_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {INC_PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </Card>

          <Card className={s.card}>
            <Text weight="semibold">3. Tell us more</Text>
            {def.questions.map((q) => (
              <Field key={q.key} label={q.label} required={q.required} hint={q.hint}>
                <QuestionInput spec={q} value={answers[q.key]} onChange={(v) => setAnswers((prev) => ({ ...prev, [q.key]: v }))} />
              </Field>
            ))}
            <Field label="Title" required hint="A short summary the team will see in the list.">
              <Input
                value={title}
                maxLength={160}
                onChange={(_, d) => {
                  setTitle(d.value);
                  setTitleTouched(true);
                }}
              />
            </Field>
            <Field label="What is happening?" required hint="What you see or hear, who it affects, and what you have already tried.">
              <Textarea value={description} maxLength={8000} rows={5} resize="vertical" onChange={(_, d) => setDescription(d.value)} />
            </Field>
            <Field label="A number we can reach you on" hint="Optional - if it is quicker to talk it through.">
              <Input value={contactPhone} maxLength={40} onChange={(_, d) => setContactPhone(d.value)} />
            </Field>
          </Card>

          <Card className={s.card}>
            <Text weight="semibold">4. Example calls</Text>
            <Text size={200} className={s.muted}>
              Calls that went wrong are the quickest way for us to find the cause. Add the time, who called whom, and what happened. Several examples are better than one.
            </Text>
            {calls.map((c) => (
              <div key={c.key} className={s.call}>
                <Field label="When">
                  <Input value={c.at ?? ''} placeholder="Today about 10:15" maxLength={60} onChange={(_, d) => setCall(c.key, { at: d.value })} />
                </Field>
                <Field label="Direction">
                  <Select value={c.direction ?? 'unknown'} onChange={(_, d) => setCall(c.key, { direction: d.value as IncExampleCall['direction'] })}>
                    {INC_CALL_DIRECTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d === 'unknown' ? 'Not sure' : d[0]!.toUpperCase() + d.slice(1)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="From">
                  <Input value={c.from ?? ''} maxLength={80} onChange={(_, d) => setCall(c.key, { from: d.value })} />
                </Field>
                <Field label="To">
                  <Input value={c.to ?? ''} maxLength={80} onChange={(_, d) => setCall(c.key, { to: d.value })} />
                </Field>
                <Field label="What happened">
                  <Input value={c.note ?? ''} maxLength={500} onChange={(_, d) => setCall(c.key, { note: d.value })} />
                </Field>
                <Button appearance="subtle" icon={<DeleteRegular />} aria-label="Remove this example" onClick={() => setCalls((prev) => prev.filter((x) => x.key !== c.key))} />
              </div>
            ))}
            <div>
              <Button disabled={calls.length >= 10} onClick={() => setCalls((prev) => [...prev, { key: Date.now() + prev.length, direction: 'unknown' }])}>
                Add an example call
              </Button>
            </div>
          </Card>

          <Card className={s.card}>
            <Text weight="semibold">5. Screenshots or traces (optional)</Text>
            <input
              ref={picker}
              type="file"
              multiple
              style={{ display: 'none' }}
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.pptx,.csv,.txt"
              onChange={(e) => {
                setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])].slice(0, 10));
                e.target.value = '';
              }}
            />
            <div className={cs.actions}>
              <Button onClick={() => picker.current?.click()}>Attach files</Button>
              <Text size={200} className={s.muted}>
                Pictures, PDFs, Office documents, CSV and text files up to 10 MB each.
              </Text>
            </div>
            {files.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    {f.name}{' '}
                    <Link onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>Remove</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {missing.length > 0 && (
            <div>
              <Text weight="semibold">Still needed before you can send it</Text>
              <ul className={s.missing}>
                {missing.map((m) => (
                  <li key={m}>
                    <Text size={200}>{m}</Text>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {create.isError && <Text className={cs.error}>{errorText(create.error, 'Could not raise the incident')}</Text>}
          <div className={cs.actions}>
            <Button appearance="primary" disabled={!parsed.success || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Raising…' : 'Raise incident'}
            </Button>
            <RouterLink to="/incidents">
              <Button appearance="secondary">Cancel</Button>
            </RouterLink>
          </div>
        </>
      )}
    </Page>
  );
}
