import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, Dropdown, Field, Input, Option, Spinner, Text, Textarea , makeStyles } from '@fluentui/react-components';
import { LICENSING_MODELS, SITE_REGIONS, type DiscoverySiteOverview, type Paginated } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { NetworkDiagram, type NetworkRow } from '../../components/NetworkDiagram';
import { LoadError, PagedSection, useRecordStyles, type FieldDef } from '../../components/records';
import { type StaffMember } from './siteShared';

const useLocalStyles = makeStyles({
  styled: { gridColumn: "1 / -1" },
});


const OVERVIEW_FIELDS: FieldDef[] = [
  { key: 'migrationId', label: 'Migration ID' },
  { key: 'region', label: 'Region', type: 'select', options: SITE_REGIONS },
  { key: 'author', label: 'Author' },
  { key: 'licensingModel', label: 'PSTN / licensing model', type: 'select', options: LICENSING_MODELS },
  { key: 'targetGoLive', label: 'Target go-live', placeholder: 'e.g. Q3 2026' },
  { key: 'primaryContactEmail', label: 'Primary contact email' },
  {
    key: 'portDocReminderDays',
    label: 'Port document reminder (days)',
    type: 'number',
    placeholder: '7',
  },
  { key: 'notes', label: 'Notes', type: 'textarea', full: true },
];

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Per-site overview. Editable only by SUPER_ADMIN / PROJECT_MANAGER / ENGINEER
 * (`discovery:sites:manage`); everyone else sees it read-only.
 */
export function OverviewTab({
  base,
  siteId,
  overview,
  assignedStaff,
  canEdit,
  locked,
  onSaved,
}: {
  base: string;
  siteId: string;
  overview: DiscoverySiteOverview;
  assignedStaff: StaffMember[];
  canEdit: boolean;
  locked: boolean;
  onSaved: () => void;
}) {
  const ls = useLocalStyles();
  const s = useRecordStyles();
  const editable = canEdit && !locked;
  const initial = () =>
    Object.fromEntries(
      OVERVIEW_FIELDS.map((f) => [f.key, (overview as Record<string, string>)?.[f.key] ?? '']),
    );
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [staffIds, setStaffIds] = useState<string[]>(overview.assignedUserIds ?? []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial());
    setStaffIds(overview.assignedUserIds ?? []);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);

  const staff = useQuery({
    queryKey: ['discovery-staff', base],
    enabled: editable,
    queryFn: () => api<StaffMember[]>(`${base}/staff`),
  });

  const nameFor = (id: string) =>
    staff.data?.find((m) => m.id === id)?.displayName ??
    assignedStaff.find((m) => m.id === id)?.displayName ??
    id.slice(0, 6);

  const dirty = useMemo(
    () =>
      OVERVIEW_FIELDS.some(
        (f) => (draft[f.key] ?? '') !== ((overview as Record<string, string>)?.[f.key] ?? ''),
      ) || !sameIds(staffIds, overview.assignedUserIds ?? []),
    [draft, staffIds, overview],
  );

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { ...draft, assignedUserIds: staffIds };
      // Numeric overview fields (e.g. portDocReminderDays) are optional server-side,
      // but an empty string would coerce to 0 and fail its min() check - omit instead.
      for (const f of OVERVIEW_FIELDS) {
        if (f.type === 'number' && body[f.key] === '') delete body[f.key];
      }
      return api(`${base}/sites/${siteId}/overview`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  return (
    <Card className={s.card}>
      <div className={s.cardHead}>
        <div>
          <Text weight="semibold">Overview</Text>
          {!editable && (
            <Text size={200} className={s.muted} block>
              {canEdit
                ? 'Locked — reopen the discovery to edit.'
                : 'Read-only. The migration team maintains this.'}
            </Text>
          )}
        </div>
        {editable && (
          <Button
            size="small"
            appearance="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Spinner size="tiny" /> : 'Save'}
          </Button>
        )}
      </div>

      <div className={s.formGrid}>
        {OVERVIEW_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} style={f.full ? { gridColumn: '1 / -1' } : undefined}>
            {!editable ? (
              <Text>{draft[f.key] || '—'}</Text>
            ) : f.type === 'textarea' ? (
              <Textarea
                value={draft[f.key] ?? ''}
                resize="vertical"
                onChange={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.value }))}
              />
            ) : f.type === 'select' ? (
              <Dropdown
                placeholder="Select…"
                selectedOptions={draft[f.key] ? [draft[f.key]!] : []}
                value={draft[f.key] ?? ''}
                onOptionSelect={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.optionValue ?? '' }))}
              >
                {(f.options ?? []).map((o) => (
                  <Option key={o} value={o}>
                    {o}
                  </Option>
                ))}
              </Dropdown>
            ) : (
              <Input
                placeholder={f.placeholder}
                value={draft[f.key] ?? ''}
                onChange={(_, d) => setDraft((v) => ({ ...v, [f.key]: d.value }))}
              />
            )}
          </Field>
        ))}

        <Field label="Assigned staff" hint="Engineers / project managers watching this site" className={ls.styled}>
          {!editable ? (
            <div className={s.chips}>
              {assignedStaff.length === 0 ? (
                <Text>—</Text>
              ) : (
                assignedStaff.map((m) => (
                  <Badge key={m.id} appearance="tint" color="informative">
                    {m.displayName} · {m.role}
                  </Badge>
                ))
              )}
            </div>
          ) : (
            <Dropdown
              multiselect
              placeholder="Select staff…"
              selectedOptions={staffIds}
              value={staffIds.map(nameFor).join(', ')}
              onOptionSelect={(_, d) => setStaffIds(d.selectedOptions)}
            >
              {(staff.data ?? []).map((m) => (
                <Option key={m.id} value={m.id} text={m.displayName}>
                  {m.displayName} · {m.role}
                </Option>
              ))}
            </Dropdown>
          )}
        </Field>
      </div>

      {error && <LoadError message={error} />}
    </Card>
  );
}

/* ---------------------------- network diagram ---------------------------- */

/**
 * Fetches every network row for the site (not just the current page) and draws
 * the diagram. Shares the `['network', tid, siteId]` key prefix with
 * PagedSection, so a CRUD there invalidates this and the picture refreshes.
 */
export function NetworkDiagramCard({ base, tid, siteId }: { base: string; tid: string; siteId: string }) {
  const s = useRecordStyles();
  const q = useQuery({
    queryKey: ['network', tid, siteId, 'all'],
    enabled: !!tid && !!siteId,
    queryFn: () => api<Paginated<NetworkRow>>(`${base}/network?siteId=${siteId}&limit=200`),
  });
  const rows = q.data?.items ?? [];

  return (
    <Card className={s.card}>
      <Text weight="semibold">Network diagram</Text>
      {q.isLoading ? (
        <Spinner size="tiny" />
      ) : rows.length === 0 ? (
        <Text size={200} className={s.muted}>
          Add subnets below to build the diagram.
        </Text>
      ) : (
        <NetworkDiagram rows={rows} />
      )}
    </Card>
  );
}

/* --------------------------- number inventory --------------------------- */
