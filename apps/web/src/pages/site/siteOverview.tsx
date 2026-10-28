import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Card, Dropdown, Field, Input, Option, Spinner, Text, Textarea  } from '@fluentui/react-components';
import { LICENSING_MODELS, SITE_REGIONS, type DiscoverySiteOverview, type Paginated, type SiteContacts } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { NetworkDiagram, type NetworkRow } from '../../components/NetworkDiagram';
import { LoadError, PagedSection, useRecordStyles, type FieldDef } from '../../components/records';
import { SiteContactsEditor, type ContactUser } from './siteContacts';

const OVERVIEW_FIELDS: FieldDef[] = [
  { key: 'region', label: 'Region', type: 'select', options: SITE_REGIONS },
  { key: 'licensingModel', label: 'PSTN / licensing model', type: 'select', options: LICENSING_MODELS },
  { key: 'targetGoLive', label: 'Target go-live', placeholder: 'e.g. Q3 2026' },
  {
    key: 'portDocReminderDays',
    label: 'Porting documentation reminder interval (days)',
    type: 'number',
    placeholder: '7',
  },
  { key: 'notes', label: 'Notes', type: 'textarea', full: true },
];

/** The people on the site in a form that compares the same however the lists were built (empty roles left out). */
const contactsKey = (c: SiteContacts | undefined) =>
  JSON.stringify(Object.entries(c ?? {}).filter(([, list]) => list && list.length).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Per-site overview. Editable only by SUPER_ADMIN / PROJECT_MANAGER / ENGINEER
 * (`discovery:sites:manage`); everyone else sees it read-only.
 */
export function OverviewTab({
  base,
  siteId,
  overview,
  contactUsers,
  canEdit,
  locked,
  onSaved,
}: {
  base: string;
  siteId: string;
  overview: DiscoverySiteOverview;
  contactUsers: ContactUser[];
  canEdit: boolean;
  locked: boolean;
  onSaved: () => void;
}) {
  const s = useRecordStyles();
  const editable = canEdit && !locked;
  const initial = () =>
    Object.fromEntries(
      OVERVIEW_FIELDS.map((f) => [f.key, (overview as Record<string, string>)?.[f.key] ?? '']),
    );
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [contacts, setContacts] = useState<SiteContacts>(overview.contacts ?? {});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial());
    setContacts(overview.contacts ?? {});
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);

  const candidates = useQuery({
    queryKey: ['discovery-contact-candidates', base],
    enabled: editable,
    queryFn: () => api<ContactUser[]>(`${base}/contact-candidates`),
  });

  const dirty = useMemo(
    () =>
      OVERVIEW_FIELDS.some(
        (f) => (draft[f.key] ?? '') !== ((overview as Record<string, string>)?.[f.key] ?? ''),
      ) || contactsKey(contacts) !== contactsKey(overview.contacts),
    [draft, contacts, overview],
  );

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { ...draft, contacts };
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
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <div>
          <Text weight="semibold">People</Text>
          <Text size={200} className={s.muted} block>
            Who is on this site, by role. Pick from the active users or add someone by name and email. Each role can hold several people.
          </Text>
        </div>
        <SiteContactsEditor
          value={contacts}
          onChange={setContacts}
          editable={editable}
          candidates={candidates.data ?? []}
          knownUsers={contactUsers}
        />
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
