import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Field, Input, Select, Spinner, Text, makeStyles, shorthands, tokens , mergeClasses } from '@fluentui/react-components';
import { INTAKE_KINDS, INTAKE_KIND_LABELS, INTAKE_SEVERITIES, INTAKE_SEVERITY_LABELS, type IntakeConfig, type IntakeKind, type IntakeSeverity } from '@tvmf/shared';
import { api } from '../api';
import { errorText, when } from '../pages/ServiceRequests';

const useLocalStyles = makeStyles({
  justifySpacebetween: { justifyContent: "space-between" },
  flexMlAuto: { marginLeft: "auto", display: "flex", columnGap: '6px' },
  colItemsStretch: { flexDirection: "column", alignItems: "stretch" },
});


const useStyles = makeStyles({
  box: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS },
  row: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS, alignItems: 'end' },
  muted: { color: tokens.colorNeutralForeground3 },
  error: { color: tokens.colorPaletteRedForeground1 },
  item: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXS, ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2) },
  secret: { fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all', ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM), ...shorthands.borderRadius(tokens.borderRadiusMedium), backgroundColor: tokens.colorNeutralBackground3 },
});

interface Source {
  id: string;
  name: string;
  kind: IntakeKind;
  config: IntakeConfig;
  enabled: boolean;
  hint: string;
  last_used_at: string | null;
  alerts_received: number;
}

/**
 * Monitoring alert sources for this customer (docs/INTAKE.md): tools that post alerts (an SBC, Teams service health, call quality,
 * Microsoft 365 service health). Everyone on the team sees them; Super Admins add, switch off, rotate and remove. A token is
 * shown once, when it is made.
 */
export function IntakeSources({ base, editable }: { base: string; editable: boolean }) {
  const ls = useLocalStyles();
  const s = useStyles();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['intake-sources', base], queryFn: () => api<Source[]>(`${base}/intake-sources`) });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<IntakeKind>('generic');
  const [siteCode, setSiteCode] = useState('');
  const [minSeverity, setMinSeverity] = useState<IntakeSeverity | ''>('');
  const [autoRestore, setAutoRestore] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['intake-sources', base] });
  const create = useMutation({
    mutationFn: () => api<{ name: string; token: string }>(`${base}/intake-sources`, { method: 'POST', body: JSON.stringify({ name, kind, config: { ...(siteCode.trim() ? { siteCode: siteCode.trim() } : {}), ...(minSeverity ? { minSeverity } : {}), ...(autoRestore ? { autoRestore: true } : {}) } }) }),
    onSuccess: (r) => {
      setFresh({ name: r.name, token: r.token });
      setAdding(false);
      setName('');
      setSiteCode('');
      setMinSeverity('');
      setAutoRestore(false);
      refresh();
    },
  });
  const toggle = useMutation({ mutationFn: (v: { id: string; enabled: boolean }) => api(`${base}/intake-sources/${v.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: v.enabled }) }), onSuccess: refresh });
  const rotate = useMutation({ mutationFn: (id: string) => api<{ name: string; token: string }>(`${base}/intake-sources/${id}/rotate`, { method: 'POST' }), onSuccess: (r) => (setFresh({ name: r.name, token: r.token }), refresh()) });
  const remove = useMutation({ mutationFn: (id: string) => api(`${base}/intake-sources/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const error = create.error ?? toggle.error ?? rotate.error ?? remove.error;
  // The configured base URL (Administration > Platform settings) when we can read it, else the address this page was opened at.
  const baseUrl = useQuery({ queryKey: ['platform-settings'], queryFn: () => api<{ connect: { intakeAlerts: string } } | null>('/platform/settings'), staleTime: 60_000 });
  const url = baseUrl.data?.connect.intakeAlerts ?? `${window.location.origin}/api/intake/v1/alerts`;

  return (
    <div className={s.box}>
      <div className={mergeClasses(s.row, ls.justifySpacebetween)}>
        <Text weight="semibold">Alert sources</Text>
        {editable && !adding && (
          <Button size="small" onClick={() => setAdding(true)}>
            Add a source
          </Button>
        )}
      </div>
      <Text size={200} className={s.muted}>
        A monitoring tool posts alerts to <code>{url}</code> with its token. The same alert (the same <code>dedupKey</code>) is one incident however often it fires, and a &ldquo;resolved&rdquo; alert notes that it cleared.
      </Text>
      {fresh && (
        <div className={s.box}>
          <Text weight="semibold">Token for {fresh.name}: copy it now, it is not shown again.</Text>
          <div className={s.secret}>{fresh.token}</div>
          <Text size={200} className={s.muted}>
            Send <code>Authorization: Bearer …</code> with <code>{'{"dedupKey":"sbc1-trunk","title":"SBC trunk down","severity":"major","state":"firing"}'}</code>. Check it with <code>GET /api/intake/v1/ping</code>.
          </Text>
          <div>
            <Button size="small" onClick={() => setFresh(null)}>
              I have copied it
            </Button>
          </div>
        </div>
      )}
      {list.isLoading && <Spinner size="tiny" />}
      {list.data?.length === 0 && !adding && <Text size={200}>No alert sources yet.</Text>}
      {list.data?.map((x) => (
        <div key={x.id} className={s.item}>
          <Text weight="semibold">{x.name}</Text>
          <Badge appearance="outline">{INTAKE_KIND_LABELS[x.kind]}</Badge>
          <Badge appearance="tint" color={x.enabled ? 'success' : 'subtle'}>
            {x.enabled ? 'On' : 'Off'}
          </Badge>
          <Text size={200} className={s.muted}>
            {x.hint} · {x.alerts_received} alert{x.alerts_received === 1 ? '' : 's'} · {x.last_used_at ? `last ${when(x.last_used_at)}` : 'never used'}
            {x.config.minSeverity ? ` · from ${INTAKE_SEVERITY_LABELS[x.config.minSeverity].toLowerCase()} up` : ''}
            {x.config.autoRestore ? ' · restores when cleared' : ''}
            {x.config.siteCode ? ` · site ${x.config.siteCode}` : ''}
          </Text>
          {editable && (
            <span className={ls.flexMlAuto}>
              <Button size="small" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: x.id, enabled: !x.enabled })}>
                {x.enabled ? 'Switch off' : 'Switch on'}
              </Button>
              <Button size="small" disabled={rotate.isPending} onClick={() => window.confirm('Make a new token? The old one stops working now.') && rotate.mutate(x.id)}>
                New token
              </Button>
              <Button size="small" disabled={remove.isPending} onClick={() => window.confirm(`Remove ${x.name}?`) && remove.mutate(x.id)}>
                Remove
              </Button>
            </span>
          )}
        </div>
      ))}
      {adding && (
        <div className={mergeClasses(s.item, ls.colItemsStretch)}>
          <div className={s.row}>
            <Field label="Name" required>
              <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="SBC monitoring" />
            </Field>
            <Field label="What sends it">
              <Select value={kind} onChange={(_, d) => setKind(d.value as IntakeKind)}>
                {INTAKE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {INTAKE_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Site code (if alerts don't say)">
              <Input value={siteCode} onChange={(_, d) => setSiteCode(d.value)} placeholder="RDG01" />
            </Field>
            <Field label="Ignore alerts below">
              <Select value={minSeverity} onChange={(_, d) => setMinSeverity(d.value as IntakeSeverity | '')}>
                <option value="">Nothing: raise them all</option>
                {INTAKE_SEVERITIES.map((v) => (
                  <option key={v} value={v}>
                    {INTAKE_SEVERITY_LABELS[v]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Checkbox checked={autoRestore} onChange={(_, d) => setAutoRestore(!!d.checked)} label="Move the incident to Restored when the alert clears (only once an engineer has picked it up)" />
          <div className={s.row}>
            <Button appearance="primary" size="small" disabled={name.trim().length < 2 || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Adding…' : 'Add and show the token'}
            </Button>
            <Button size="small" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <Text className={s.error}>{errorText(error, 'That did not work')}</Text>}
    </div>
  );
}
