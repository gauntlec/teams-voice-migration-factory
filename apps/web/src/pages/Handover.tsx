import { lazy, Suspense, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
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
import { Dialog } from '../components/AppDialog';
import {
  HANDOVER_NOTE_SECTIONS,
  HANDOVER_SECTIONS,
  handoverScopeLabel,
  type HandoverNoteSection,
  noteLine,
  type CallFlowGraph,
  type HandoverBlock,
  type HandoverSectionContent,
  handoverFileName,
  issuedHandoverVersionLabel,
  sameHandoverScope,
  type HandoverUnportedRange,
} from '@tvmf/shared';
import { api, apiDownload, apiUpload, ApiError } from '../api';
import { useNotify } from '../hooks/useNotify';
import type { CapturedDiagram } from '../components/CallFlowDiagram';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from './DataCollection';
import { DangerText } from '../components/ui';
import { TableSkeleton } from '../components/states';
import { HandoverActionsDialog } from './handover/handoverActions';

const useLocalStyles = makeStyles({
  w92vwMaxW1100: { maxWidth: "1100px", width: "92vw" },
  maxH70vhScroll: { maxHeight: "70vh", overflowY: "auto" },
});


interface PackSource {
  siteCodes?: string[];
  sectionKeys?: string[];
  notes?: string | null;
  /** the cover's project line */
  projectName?: string | null;
  /** the sites it covers (none = all sites): each set of sites has its own version numbers */
  siteIds?: string[];
}

interface Pack {
  id: string;
  version: number;
  /** major.minor: 0.x drafts, 1.0 the first issue, then 1.x */
  version_label: string | null;
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
  unportedList: { ...shorthands.margin(tokens.spacingVerticalXS, 0, 0), paddingLeft: tokens.spacingHorizontalL, maxHeight: '160px', overflowY: 'auto' },
});

// Loaded on its own: it brings the diagram library, which only generating a pack needs here.
const CallFlowCapture = lazy(() => import('../components/CallFlowDiagram').then((m) => ({ default: m.CallFlowCapture })));

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
  const [actionsOpen, setActionsOpen] = useState(false);
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
      await apiDownload(`/t/${activeTenantId}/files/${p.file_id}/download`, handoverFileName(p.source?.siteCodes, packVersion(p)));
    } catch (e) {
      setActionError(errorMessage(e, 'Could not download the file'));
    }
  };

  const [approval, setApproval] = useState({ company: '', name: '', date: new Date().toISOString().slice(0, 10) });
  const issue = useMutation({
    mutationFn: (id: string) =>
      api(`/t/${activeTenantId}/handover/packs/${id}/issue`, {
        method: 'POST',
        body: JSON.stringify({ approverCompany: approval.company.trim() || undefined, approverName: approval.name.trim() || undefined, approvalDate: approval.date || undefined }),
      }),
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
        <div className={cs.rowActions}>
          <Button onClick={() => setActionsOpen(true)}>Outstanding actions</Button>
          {canGenerate && (
            <>
              <Button onClick={() => setNotesOpen(true)}>Edit notes</Button>
              <Button appearance="primary" onClick={() => setGenerateOpen(true)}>
                Generate pack
              </Button>
            </>
          )}
        </div>
      }
    >
      {actionError && <LoadError message={actionError} />}
      <Card>
        {packs.isLoading ? (
          <TableSkeleton rows={4} cols={5} />
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
                  <TableCell>{packVersion(p)}</TableCell>
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
          lastProject={[...(packs.data ?? [])].sort((a, b) => b.version - a.version)[0]?.source?.projectName ?? ''}
          onClose={() => setGenerateOpen(false)}
          onDone={() => {
            setGenerateOpen(false);
            qc.invalidateQueries({ queryKey: ['handover', activeTenantId] });
          }}
        />
      )}
      {notesOpen && <NotesDialog tenantId={activeTenantId} sites={sites} onClose={() => setNotesOpen(false)} />}
      {actionsOpen && <HandoverActionsDialog tenantId={activeTenantId} sites={sites} canEdit={canGenerate} onClose={() => setActionsOpen(false)} />}
      {previewId && <PreviewDialog tenantId={activeTenantId} packId={previewId} onClose={() => setPreviewId(null)} />}

      <Dialog open={!!issuing} onOpenChange={(_, d) => !d.open && setIssuing(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Issue version {issuing ? issuedHandoverVersionLabel(issuing.version_label, (packs.data ?? []).filter((x) => sameHandoverScope(x.source?.siteIds, issuing.source?.siteIds))) : ''}?</DialogTitle>
            <DialogContent className={cs.stack}>
              <Text block>
                This marks the pack as final and records who issued it and when. It can&apos;t be undone. To change anything afterwards, generate a new version.
              </Text>
              <Text block size={200}>
                Who approved and signed it off is printed in the pack&apos;s Approvals &amp; Sign-Off section.
              </Text>
              <Field label="Approved by: company" hint="Leave empty for the company whose branding the pack carries.">
                <Input value={approval.company} maxLength={120} onChange={(_, d) => setApproval((a) => ({ ...a, company: d.value }))} />
              </Field>
              <Field label="Approved by: name and title" hint="For example “Leigh Manton, AT&T Consulting, Director EMEA”.">
                <Input value={approval.name} maxLength={200} onChange={(_, d) => setApproval((a) => ({ ...a, name: d.value }))} />
              </Field>
              <Field label="Date approved">
                <Input type="date" value={approval.date} onChange={(_, d) => setApproval((a) => ({ ...a, date: d.value }))} />
              </Field>
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
  lastProject,
  onClose,
  onDone,
}: {
  tenantId: string;
  sites: SiteOption[];
  /** the project line of the newest pack, offered again */
  lastProject: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const cs = useStyles();
  const [projectName, setProjectName] = useState(lastProject);
  const [changeNote, setChangeNote] = useState('');
  // Drawing the call flow diagrams, one at a time, off-screen: the one being drawn, and how far along it is.
  const notify = useNotify();
  const [drawing, setDrawing] = useState<{ key: number; graph: CallFlowGraph; done: (shot: CapturedDiagram | null, error?: string) => void } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  /** Draws and uploads each auto attendant's diagram. A diagram that fails is left out and named afterwards, never stopping the pack. */
  const drawDiagrams = async (): Promise<{ diagrams: { name: string; fileId: string; width: number; height: number }[]; failed: string[] }> => {
    const out: { name: string; fileId: string; width: number; height: number }[] = [];
    const failed: string[] = [];
    if (!sectionKeys.has('auto_attendants')) return { diagrams: out, failed };
    setProgress('Reading the call flows from what Teams has…');
    const graphs = await api<{ name: string; graph: CallFlowGraph }[]>(`/t/${tenantId}/handover/call-flows`, { method: 'POST', body: JSON.stringify({ siteIds: mode === 'sites' ? [...siteIds] : [] }) });
    for (const [i, g] of graphs.entries()) {
      setProgress(`Drawing call flow diagrams (${i + 1} of ${graphs.length})…`);
      try {
        const shot = await new Promise<CapturedDiagram>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out')), 60_000);
          setDrawing({
            key: i,
            graph: g.graph,
            done: (s, error) => {
              clearTimeout(timer);
              if (s) resolve(s);
              else reject(new Error(error ?? 'not drawn'));
            },
          });
        });
        const up = await apiUpload<{ fileId: string }>(`/t/${tenantId}/handover/diagrams`, new File([shot.blob], `call-flow-${g.name}.png`, { type: 'image/png' }));
        out.push({ name: g.name, fileId: up.fileId, width: shot.width, height: shot.height });
      } catch {
        failed.push(g.name);
      }
    }
    setDrawing(null);
    return { diagrams: out, failed };
  };
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
  // Port ranges on the chosen sites not ported yet: asked about before anything is drawn or a draft made (bug report
  // "Service Handover - Pre creation check"). null = not asked yet.
  const [unported, setUnported] = useState<HandoverUnportedRange[] | null>(null);
  const generate = useMutation({
    mutationFn: async (acceptUnported: boolean): Promise<{ held: HandoverUnportedRange[] } | { failed: string[] }> => {
      if (!acceptUnported) {
        setProgress('Checking the number ranges…');
        const check = await api<{ unportedRanges: HandoverUnportedRange[] }>(`/t/${tenantId}/handover/pre-check`, {
          method: 'POST',
          body: JSON.stringify({ siteIds: mode === 'sites' ? [...siteIds] : [] }),
        });
        if (check.unportedRanges.length) return { held: check.unportedRanges };
      }
      const { diagrams, failed } = await drawDiagrams().catch(() => ({ diagrams: [], failed: ['the call flow diagrams'] }));
      setProgress('Generating the pack…');
      await api(`/t/${tenantId}/handover/packs`, {
        method: 'POST',
        body: JSON.stringify({
          diagrams,
          siteIds: mode === 'sites' ? [...siteIds] : [],
          sectionKeys: allSections ? [] : [...sectionKeys],
          notes: notes.trim() || undefined,
          // empty clears it; the cover then has no project line
          projectName: projectName.trim(),
          changeNote: changeNote.trim() || undefined,
          ...(acceptUnported ? { acceptUnported: true } : {}),
        }),
      });
      return { failed };
    },
    onSuccess: (r) => {
      if ('held' in r) {
        setUnported(r.held);
        return;
      }
      const { failed } = r;
      if (failed.length) notify('The pack was generated without some call flow diagrams', { intent: 'warning', body: `Not drawn: ${failed.join(', ')}. Generate it again to retry.` });
      onDone();
    },
    onSettled: () => {
      setDrawing(null);
      setProgress(null);
    },
  });
  const invalid = sectionKeys.size === 0 || (mode === 'sites' && siteIds.size === 0);
  // a change to the sites asks again
  const changeSites = (next: () => void) => {
    setUnported(null);
    next();
  };

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Generate handover pack</DialogTitle>
          <DialogContent className={cs.stack}>
            <Field label="Sites">
              <Select value={mode} onChange={(_, d) => changeSites(() => setMode(d.value as 'all' | 'sites'))}>
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
                    onChange={(_, d) => changeSites(() => setSiteIds(toggle(siteIds, s.id, !!d.checked)))}
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
            <Field label="Project name (optional)" hint="Printed on the front page under the customer's name, for example “AT&T Global Teams Project”.">
              <Input value={projectName} maxLength={120} onChange={(_, d) => setProjectName(d.value)} />
            </Field>
            <Field label="What changed in this version (optional)" hint="Printed in the pack's Document Control table, e.g. “Section 7 added for call queues”.">
              <Input value={changeNote} maxLength={300} onChange={(_, d) => setChangeNote(d.value)} />
            </Field>
            <Field label="Internal note (optional)" hint="Kept with the pack in Voxshift. It isn't printed in the document.">
              <Textarea value={notes} maxLength={2000} onChange={(_, d) => setNotes(d.value)} resize="vertical" />
            </Field>
            {unported && unported.length > 0 && (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>
                    {unported.length === 1 ? 'A number range has not been ported yet' : `${unported.length} number ranges have not been ported yet`}
                  </MessageBarTitle>
                  The pack hands the service over, but these numbers are still with the old carrier. Create the draft anyway, or mark the ports
                  complete in Site Data &gt; Number porting first.
                  <ul className={cs.unportedList}>
                    {unported.map((r) => (
                      <li key={`${r.sitecode}-${r.start}`}>
                        {r.sitecode}
                        {r.siteName && r.siteName !== r.sitecode ? ` ${r.siteName}` : ''}: {r.start === r.end ? r.start : `${r.start} – ${r.end}`} ({r.stage})
                      </li>
                    ))}
                  </ul>
                </MessageBarBody>
              </MessageBar>
            )}
            {generate.isError && <DangerText>{errorMessage(generate.error, 'Could not generate the pack')}</DangerText>}
            {progress && (
              <Text size={200} role="status">
                {progress}
              </Text>
            )}
            {drawing && (
              <Suspense fallback={null}>
                <CallFlowCapture key={drawing.key} graph={drawing.graph} onDone={drawing.done} />
              </Suspense>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            {unported && unported.length > 0 ? (
              <Button appearance="primary" disabled={invalid || generate.isPending} onClick={() => generate.mutate(true)}>
                {generate.isPending ? 'Generating…' : 'Create the draft anyway'}
              </Button>
            ) : (
              <Button appearance="primary" disabled={invalid || generate.isPending} onClick={() => generate.mutate(false)}>
                {generate.isPending ? 'Generating…' : 'Generate pack'}
              </Button>
            )}
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

  // Switching section/site or closing used to drop unsaved text without a word.
  const okToDiscard = () => !dirty || window.confirm('Discard the changes to this note?');
  const close = () => {
    if (okToDiscard()) onClose();
  };
  const choose = (nextSection: HandoverNoteSection, nextSite: string) => {
    if (!okToDiscard()) return;
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
    <Dialog open onOpenChange={(_, d) => !d.open && close()}>
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
            <Field
              label="Note"
              hint={
                section === 'introduction'
                  ? 'Replaces the standard introduction. One paragraph per line; start a line with “- ” for a bullet. Leave empty and save to go back to the standard text.'
                  : 'One paragraph per line. Start a line with “## ” for a numbered sub-heading (e.g. “## Welcome Document”) or “- ” for a bullet. Leave empty and save to clear it.'
              }
            >
              {notesQ.isLoading ? (
                <Spinner size="tiny" />
              ) : (
                <Textarea value={body} maxLength={20000} rows={8} resize="vertical" onChange={(_, d) => setDraft(d.value)} />
              )}
            </Field>
            {save.isError && <DangerText>{errorMessage(save.error, 'Could not save the note')}</DangerText>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={close}>
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
  const ls = useLocalStyles();
  const cs = useStyles();
  const q = useQuery({
    queryKey: ['handover-pack', tenantId, packId],
    queryFn: () => api<{ pack: Pack; sections: PackSection[] }>(`/t/${tenantId}/handover/packs/${packId}`),
  });

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.w92vwMaxW1100}>
        <DialogBody>
          <DialogTitle>
            {q.data ? `Pack v${packVersion(q.data.pack)} — ${handoverScopeLabel(q.data.pack.source?.siteCodes)}` : 'Pack preview'}
          </DialogTitle>
          <DialogContent className={ls.maxH70vhScroll}>
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
          <NoteLineText key={i} line={p} />
        ))}
      </div>
    );
  }
  if (content.kind === 'blocks') {
    return (
      <div className={cs.stack}>
        {content.blocks.map((b, i) => (
          <PreviewBlock key={i} block={b} />
        ))}
      </div>
    );
  }
  return <PreviewTable columns={content.columns} rows={content.rows} />;
}

/** A note line as the pack prints it: "## " a sub-heading, "- " a bullet, else a paragraph. */
function NoteLineText({ line }: { line: string }) {
  const n = noteLine(line);
  if (n.kind === 'heading') return <Text weight="semibold" block>{n.text}</Text>;
  return <Text block>{n.kind === 'bullet' ? `• ${n.text}` : n.text}</Text>;
}

function PreviewBlock({ block: b }: { block: HandoverBlock }) {
  const cs = useStyles();
  switch (b.kind) {
    case 'heading':
      return <Text weight="semibold" block>{b.title}</Text>;
    case 'text':
      return <NoteLineText line={b.text} />;
    case 'bullets':
      return (
        <div>
          {b.items.map((it, i) => (
            <Text key={i} block>
              {it.startsWith('  ') ? `\u00a0\u00a0\u00a0\u00a0◦ ${it.trim()}` : `• ${it}`}
            </Text>
          ))}
        </div>
      );
    case 'table':
      return <PreviewTable columns={b.columns} rows={b.rows} caption={b.caption} />;
    case 'labels':
      return <PreviewTable columns={['', '']} rows={b.rows.map(([k, v]) => [k, v.replace(/\n/g, ', ')])} caption={b.caption} />;
    case 'cards':
      return (
        <div className={cs.stack}>
          {b.cards.map((c, i) => (
            <PreviewTable key={i} columns={['', '']} rows={c.map(([k, v]) => [k, v.replace(/\n/g, ', ')])} />
          ))}
          {b.caption && <Text size={200} italic>{b.caption}</Text>}
        </div>
      );
    case 'image':
      return (
        <Text size={200} block>
          Call flow diagram: {b.title} (a picture in the document)
        </Text>
      );
    case 'actions':
      return <PreviewTable columns={['Description', 'Owner and Action']} rows={b.items.map((a) => [a.description, a.owner])} caption={b.caption} />;
  }
}

function PreviewTable({ columns, rows, caption }: { columns: string[]; rows: string[][]; caption?: string }) {
  if (rows.length === 0) return <Text size={200}>Nothing recorded.</Text>;
  const shown = rows.slice(0, PREVIEW_ROWS);
  const header = columns.some((c) => c !== '');
  return (
    <>
      <DataTable size="small" minWidth={Math.max(520, columns.length * 140)}>
        {header && (
          <TableHeader>
            <TableRow>
              {columns.map((c, i) => (
                <TableHeaderCell key={i}>{c}</TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
        )}
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
      {rows.length > shown.length && (
        <Text size={200}>
          Showing the first {shown.length} of {rows.length} rows. The .docx has all of them.
        </Text>
      )}
      {caption && (
        <Text size={200} italic>
          {caption}
        </Text>
      )}
    </>
  );
}

/** A pack's version as printed in it: its major.minor label (older packs: their number). */
function packVersion(p: Pack): string {
  return p.version_label ?? String(p.version);
}
