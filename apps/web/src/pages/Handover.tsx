import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  Link,
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
} from '@fluentui/react-components';
import {
  HANDOVER_NOTE_SECTIONS,
  HANDOVER_SECTIONS,
  handoverScopeLabel,
  type HandoverNoteSection,
  type HandoverSectionContent,
} from '@tvmf/shared';
import { api, apiDownload, ApiError } from '../api';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from './DataCollection';

interface PackSource {
  siteCodes?: string[];
  sectionKeys?: string[];
  notes?: string | null;
}

interface Pack {
  id: string;
  version: number;
  status: 'draft' | 'issued';
  generated_at: string | null;
  file_id: string | null;
  issued_at: string | null;
  source: PackSource | null;
  created_at: string;
}

interface PackSection {
  id: string;
  key: string;
  title: string;
  ordinal: number;
  content: HandoverSectionContent;
}

interface Note {
  id: string;
  section_key: HandoverNoteSection;
  site_id: string | null;
  sitecode: string | null;
  body: string;
  updated_at: string;
}

interface SiteOption {
  id: string;
  sitecode: string;
  name: string | null;
}

const SECTION_TITLE = Object.fromEntries(HANDOVER_SECTIONS.map((s) => [s.key, s.title])) as Record<string, string>;
/** Rows shown per table in the preview; the .docx always carries every row. */
const PREVIEW_ROWS = 200;

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS, maxHeight: '260px', overflowY: 'auto' },
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  previewSection: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalL },
  note: {
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
  },
  rowActions: { display: 'flex', columnGap: tokens.spacingHorizontalM, alignItems: 'center' },
});

function errorMessage(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

export function Handover() {
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const cs = useStyles();
  const [actionError, setActionError] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [issuing, setIssuing] = useState<Pack | null>(null);

  const packs = useQuery({
    queryKey: ['handover', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<Pack[]>(`/t/${activeTenantId}/handover/packs`),
  });
  const sitesQ = useQuery({
    queryKey: ['discovery', activeTenantId],
    enabled: !!activeTenantId,
    queryFn: () => api<{ sites: SiteOption[] }>(`/t/${activeTenantId}/discovery`),
  });
  const sites = sitesQ.data?.sites ?? [];

  const download = async (p: Pack) => {
    setActionError(null);
    try {
      await apiDownload(`/t/${activeTenantId}/files/${p.file_id}/download`, `service-handover-v${p.version}.docx`);
    } catch (e) {
      setActionError(errorMessage(e, 'Could not download the file'));
    }
  };

  const issue = useMutation({
    mutationFn: (id: string) => api(`/t/${activeTenantId}/handover/packs/${id}/issue`, { method: 'POST' }),
    onSuccess: () => {
      setIssuing(null);
      qc.invalidateQueries({ queryKey: ['handover', activeTenantId] });
    },
    onError: (e) => {
      setIssuing(null);
      setActionError(errorMessage(e, 'Could not issue the pack'));
    },
  });

  if (!activeTenantId) return <NoTenant />;
  if (packs.isError) return <LoadError message={(packs.error as Error).message} />;

  const canGenerate = can('handover:generate');
  const canIssue = can('handover:issue');

  return (
    <Page
      title="Service Handover"
      subtitle="Generate a handover pack from the final configuration, for all sites or just some. Add the notes Voxshift can't collect itself, preview the pack, then issue it once it's final."
      actions={
        canGenerate ? (
          <div className={cs.rowActions}>
            <Button onClick={() => setNotesOpen(true)}>Edit notes</Button>
            <Button appearance="primary" onClick={() => setGenerateOpen(true)}>
              Generate pack
            </Button>
          </div>
        ) : undefined
      }
    >
      {actionError && <LoadError message={actionError} />}
      <Card>
        {packs.isLoading ? (
          <Spinner size="tiny" />
        ) : (packs.data?.length ?? 0) === 0 ? (
          <Text size={200}>No handover packs generated yet.</Text>
        ) : (
          <DataTable size="small" minWidth={760}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Scope</TableHeaderCell>
                <TableHeaderCell>Sections</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {packs.data!.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>v{p.version}</TableCell>
                  <TableCell>{handoverScopeLabel(p.source?.siteCodes)}</TableCell>
                  <TableCell>
                    {p.source?.sectionKeys?.length ?? HANDOVER_SECTIONS.length} of {HANDOVER_SECTIONS.length}
                  </TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={p.status === 'issued' ? 'success' : 'informative'}>
                      {p.status}
                    </Badge>
                    {p.issued_at && (
                      <Text size={100} block>
                        {new Date(p.issued_at).toLocaleDateString()}
                      </Text>
                    )}
                  </TableCell>
                  <TableCell>{new Date(p.created_at).toLocaleString()}</TableCell>
                  <TableCell>
                    <div className={cs.rowActions}>
                      <Link onClick={() => setPreviewId(p.id)}>Preview</Link>
                      {p.file_id && <Link onClick={() => download(p)}>Download .docx</Link>}
                      {canIssue && p.status === 'draft' && p.file_id && <Link onClick={() => setIssuing(p)}>Issue</Link>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>

      {generateOpen && (
        <GenerateDialog
          tenantId={activeTenantId}
          sites={sites}
          onClose={() => setGenerateOpen(false)}
          onDone={() => {
            setGenerateOpen(false);
            qc.invalidateQueries({ queryKey: ['handover', activeTenantId] });
          }}
        />
      )}
      {notesOpen && <NotesDialog tenantId={activeTenantId} sites={sites} onClose={() => setNotesOpen(false)} />}
      {previewId && <PreviewDialog tenantId={activeTenantId} packId={previewId} onClose={() => setPreviewId(null)} />}

      <Dialog open={!!issuing} onOpenChange={(_, d) => !d.open && setIssuing(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Issue v{issuing?.version}?</DialogTitle>
            <DialogContent>
              <Text block>
                This marks the pack as final and records who issued it and when. It can&apos;t be undone. To change anything afterwards, generate a new version.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setIssuing(null)}>
                Cancel
              </Button>
              <Button appearance="primary" disabled={issue.isPending} onClick={() => issuing && issue.mutate(issuing.id)}>
                Issue pack
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Page>
  );
}

/* ------------------------------ generate ------------------------------ */

function GenerateDialog({
  tenantId,
  sites,
  onClose,
  onDone,
}: {
  tenantId: string;
  sites: SiteOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  const cs = useStyles();
  const [mode, setMode] = useState<'all' | 'sites'>('all');
  const [siteIds, setSiteIds] = useState<Set<string>>(new Set());
  const [sectionKeys, setSectionKeys] = useState<Set<string>>(new Set(HANDOVER_SECTIONS.map((s) => s.key)));
  const [notes, setNotes] = useState('');

  const toggle = (set: Set<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

  const allSections = sectionKeys.size === HANDOVER_SECTIONS.length;
  const generate = useMutation({
    mutationFn: () =>
      api(`/t/${tenantId}/handover/packs`, {
        method: 'POST',
        body: JSON.stringify({
          siteIds: mode === 'sites' ? [...siteIds] : [],
          sectionKeys: allSections ? [] : [...sectionKeys],
          notes: notes.trim() || undefined,
        }),
      }),
    onSuccess: onDone,
  });
  const invalid = sectionKeys.size === 0 || (mode === 'sites' && siteIds.size === 0);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Generate handover pack</DialogTitle>
          <DialogContent className={cs.stack}>
            <Field label="Sites">
              <Select value={mode} onChange={(_, d) => setMode(d.value as 'all' | 'sites')}>
                <option value="all">All sites</option>
                <option value="sites">Specific sites</option>
              </Select>
            </Field>
            {mode === 'sites' && (
              <div className={cs.list}>
                {sites.length === 0 && <Text size={200}>No sites yet.</Text>}
                {sites.map((s) => (
                  <Checkbox
                    key={s.id}
                    label={s.name ? `${s.sitecode} — ${s.name}` : s.sitecode}
                    checked={siteIds.has(s.id)}
                    onChange={(_, d) => setSiteIds(toggle(siteIds, s.id, !!d.checked))}
                  />
                ))}
              </div>
            )}
            <Field label={`Sections (${sectionKeys.size} of ${HANDOVER_SECTIONS.length})`}>
              <div className={cs.list}>
                {HANDOVER_SECTIONS.map((s) => (
                  <Checkbox
                    key={s.key}
                    label={s.title}
                    checked={sectionKeys.has(s.key)}
                    onChange={(_, d) => setSectionKeys(toggle(sectionKeys, s.key, !!d.checked))}
                  />
                ))}
              </div>
            </Field>
            <Field label="Internal note (optional)" hint="Kept with the pack in Voxshift. It isn't printed in the document.">
              <Textarea value={notes} maxLength={2000} onChange={(_, d) => setNotes(d.value)} resize="vertical" />
            </Field>
            {generate.isError && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{errorMessage(generate.error, 'Could not generate the pack')}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={invalid || generate.isPending} onClick={() => generate.mutate()}>
              {generate.isPending ? 'Generating…' : 'Generate pack'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------------- notes ------------------------------- */

function NotesDialog({ tenantId, sites, onClose }: { tenantId: string; sites: SiteOption[]; onClose: () => void }) {
  const cs = useStyles();
  const qc = useQueryClient();
  const notesQ = useQuery({
    queryKey: ['handover-notes', tenantId],
    queryFn: () => api<Note[]>(`/t/${tenantId}/handover/notes`),
  });
  const notes = notesQ.data ?? [];

  const [section, setSection] = useState<HandoverNoteSection>(HANDOVER_NOTE_SECTIONS[0]);
  const [siteId, setSiteId] = useState(''); // '' = every site
  // The draft is edited locally and re-seeded from the saved note whenever the section or site changes.
  const [draft, setDraft] = useState<string | null>(null);

  const saved = useMemo(
    () => notes.find((n) => n.section_key === section && (n.site_id ?? '') === siteId)?.body ?? '',
    [notes, section, siteId],
  );
  const body = draft ?? saved;
  const dirty = body !== saved;

  const choose = (nextSection: HandoverNoteSection, nextSite: string) => {
    setSection(nextSection);
    setSiteId(nextSite);
    setDraft(null);
  };

  const save = useMutation({
    mutationFn: (text: string) =>
      api(`/t/${tenantId}/handover/notes`, {
        method: 'PUT',
        body: JSON.stringify({ sectionKey: section, siteId: siteId || null, body: text }),
      }),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['handover-notes', tenantId] });
    },
  });

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Handover notes</DialogTitle>
          <DialogContent className={cs.stack}>
            <Text size={200}>
              These sections have no data source in Voxshift, so they&apos;re written here and printed in the pack. A note for all sites appears in every pack; a site note only in packs that include that site.
            </Text>
            <Field label="Section">
              <Select value={section} onChange={(_, d) => choose(d.value as HandoverNoteSection, siteId)}>
                {HANDOVER_NOTE_SECTIONS.map((k) => (
                  <option key={k} value={k}>
                    {SECTION_TITLE[k]}
                    {notes.some((n) => n.section_key === k) ? ' ●' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Applies to">
              <Select value={siteId} onChange={(_, d) => choose(section, d.value)}>
                <option value="">All sites</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.sitecode}
                    {notes.some((n) => n.section_key === section && n.site_id === s.id) ? ' ●' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Note" hint="One paragraph per line. Leave empty and save to clear it.">
              {notesQ.isLoading ? (
                <Spinner size="tiny" />
              ) : (
                <Textarea value={body} maxLength={20000} rows={8} resize="vertical" onChange={(_, d) => setDraft(d.value)} />
              )}
            </Field>
            {save.isError && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{errorMessage(save.error, 'Could not save the note')}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
            <Button appearance="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(body)}>
              {save.isPending ? 'Saving…' : body.trim() === '' && saved !== '' ? 'Clear note' : 'Save note'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------------ preview ------------------------------ */

function PreviewDialog({ tenantId, packId, onClose }: { tenantId: string; packId: string; onClose: () => void }) {
  const cs = useStyles();
  const q = useQuery({
    queryKey: ['handover-pack', tenantId, packId],
    queryFn: () => api<{ pack: Pack; sections: PackSection[] }>(`/t/${tenantId}/handover/packs/${packId}`),
  });

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: '1100px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>
            {q.data ? `Pack v${q.data.pack.version} — ${handoverScopeLabel(q.data.pack.source?.siteCodes)}` : 'Pack preview'}
          </DialogTitle>
          <DialogContent style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            {q.isLoading && <Spinner size="tiny" />}
            {q.isError && <LoadError message={(q.error as Error).message} />}
            {q.data?.sections.map((s) => (
              <div key={s.id} className={cs.previewSection}>
                <Text weight="semibold" size={400}>
                  {s.title}
                </Text>
                <SectionBody content={s.content} />
              </div>
            ))}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function SectionBody({ content }: { content: HandoverSectionContent }) {
  const cs = useStyles();
  if (content.kind === 'placeholder') {
    return <div className={cs.note}>{content.note}</div>;
  }
  if (content.kind === 'paragraphs') {
    return (
      <div className={cs.stack}>
        {content.paragraphs.map((p, i) => (
          <Text key={i} block>
            {p}
          </Text>
        ))}
      </div>
    );
  }
  if (content.rows.length === 0) return <Text size={200}>Nothing recorded.</Text>;
  const shown = content.rows.slice(0, PREVIEW_ROWS);
  return (
    <>
      <DataTable size="small" minWidth={Math.max(520, content.columns.length * 140)}>
        <TableHeader>
          <TableRow>
            {content.columns.map((c) => (
              <TableHeaderCell key={c}>{c}</TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell key={j}>{cell || '—'}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
      {content.rows.length > shown.length && (
        <Text size={200}>
          Showing the first {shown.length} of {content.rows.length} rows. The .docx has all of them.
        </Text>
      )}
    </>
  );
}
