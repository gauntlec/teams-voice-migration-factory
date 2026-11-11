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
  SearchBox,
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
  nextHandoverVersionLabel,
  sameHandoverScope,
  type HandoverUnportedRange,
  HANDOVER_SITE_STATUS_LABELS,
  type HandoverSiteRow,
  type HandoverSiteStatus,
} from '@tvmf/shared';
import { api, apiDownload, apiUpload, ApiError } from '../api';
import { useNotify } from '../hooks/useNotify';
import type { CapturedDiagram } from '../components/CallFlowDiagram';
import { useAuth } from '../auth';
import { DataTable } from '../components/DataTable';
import { Page } from '../components/Page';
import { LoadError, NoTenant } from './DataCollection';
import { DangerText } from '../components/ui';
import { EmptyState, TableSkeleton } from '../components/states';
import { RowLink } from '../components/RowLink';
import { useSort } from '../lib/sort';
import { HandoverActionsDialog } from './handover/handoverActions';

const useLocalStyles = makeStyles({
  w92vwMaxW1100: { maxWidth: "1100px", width: "92vw" },
  maxH70vhScroll: { maxHeight: "70vh", overflowY: "auto" },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS },
  search: { flex: '1 1 260px', maxWidth: '380px' },
  muted: { color: tokens.colorNeutralForeground3 },
  cardHead: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalS },
});


export interface PackSource {
  siteCodes?: string[];
  /** what changed in this version (printed in Document Control) */
  changeNote?: string | null;
  /** 'uploaded': edited in Word and uploaded again (docs/HANDOVER-VIEW.md step 3); issued as uploaded */
  origin?: 'uploaded';
  uploadedFrom?: { id: string; version: string };
  uploadedFileName?: string;
  sectionKeys?: string[];
  notes?: string | null;
  /** the cover's project line */
  projectName?: string | null;
  /** the sites it covers (none = all sites): each set of sites has its own version numbers */
  siteIds?: string[];
}

export interface Pack {
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
  generated_by_name?: string | null;
  issued_by_name?: string | null;
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

export interface SiteOption {
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

/** Every pack the user may see (customers: issued ones only), newest first. */
export function useHandoverPacks(tenantId: string | null) {
  return useQuery({
    queryKey: ['handover', tenantId],
    enabled: !!tenantId,
    queryFn: () => api<Pack[]>(`/t/${tenantId}/handover/packs`),
  });
}

/** Every site with its handover status (GET handover/sites). */
export function useHandoverSites(tenantId: string | null) {
  return useQuery({
    queryKey: ['handover-sites', tenantId],
    enabled: !!tenantId,
    queryFn: () => api<HandoverSiteRow[]>(`/t/${tenantId}/handover/sites`),
  });
}

/** A pack for exactly one site counts towards that site's status; any other is a pack covering several sites (or every site). */
export const isSitePack = (p: Pack) => (p.source?.siteIds?.length ?? 0) === 1;

export async function downloadPack(tenantId: string, p: Pack) {
  await apiDownload(`/t/${tenantId}/files/${p.file_id}/download`, handoverFileName(p.source?.siteCodes, packVersion(p)));
}

const STATUS_COLOR: Record<HandoverSiteStatus, 'informative' | 'success' | 'subtle'> = { not_created: 'subtle', draft: 'informative', issued: 'success' };
const STATUS_ORDER: Record<HandoverSiteStatus, number> = { not_created: 0, draft: 1, issued: 2 };

/** A site's status as a badge: "Draft 1.1", "Issued 1.0", "Not created". */
export function SiteStatusBadge({ row }: { row: Pick<HandoverSiteRow, 'status' | 'latestVersion'> }) {
  return (
    <Badge appearance="tint" color={STATUS_COLOR[row.status]}>
      {HANDOVER_SITE_STATUS_LABELS[row.status]}
      {row.latestVersion ? ` ${row.latestVersion}` : ''}
    </Badge>
  );
}

export const whenShort = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Service Handover (docs/HANDOVER-VIEW.md): every site with its own pack's status, searchable, each opening its own page. Packs that
 * cover several sites, or every site, are listed underneath and don't set any one site's status.
 */
export function Handover() {
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const cs = useStyles();
  const ls = useLocalStyles();
  const [actionError, setActionError] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [issuing, setIssuing] = useState<Pack | null>(null);
  const [uploadBase, setUploadBase] = useState<Pack | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<HandoverSiteStatus | ''>('');
  const [openOnly, setOpenOnly] = useState(false);

  const packs = useHandoverPacks(activeTenantId);
  const sitesQ = useHandoverSites(activeTenantId);
  const sites = useMemo(() => (sitesQ.data ?? []).map((r) => ({ id: r.id, sitecode: r.sitecode, name: r.name })), [sitesQ.data]);
  const staff = can('handover:generate');
  const canIssue = can('handover:issue');

  const term = search.trim().toLowerCase();
  const filtered = (sitesQ.data ?? []).filter(
    (r) =>
      (!statusFilter || r.status === statusFilter) &&
      (!openOnly || (r.actions?.open ?? 0) > 0) &&
      (!term || [r.sitecode, r.name, r.country, r.region, ...r.providerPms].some((v) => (v ?? '').toLowerCase().includes(term))),
  );
  const { sorted, header } = useSort(filtered, {
    sitecode: (r) => r.sitecode,
    name: (r) => r.name ?? '',
    country: (r) => r.country ?? '',
    status: (r) => STATUS_ORDER[r.status] * 1000 + Number(r.latestVersion ?? 0),
    changed: (r) => r.lastChange?.at ?? '',
    actions: (r) => r.actions?.open ?? 0,
    pm: (r) => r.providerPms.join(', '),
  });
  const counts = (sitesQ.data ?? []).reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {} as Partial<Record<HandoverSiteStatus, number>>);
  const groupPacks = (packs.data ?? []).filter((p) => !isSitePack(p));

  if (!activeTenantId) return <NoTenant />;
  if (sitesQ.isError) return <LoadError message={(sitesQ.error as Error).message} />;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['handover', activeTenantId] });
    qc.invalidateQueries({ queryKey: ['handover-sites', activeTenantId] });
  };

  return (
    <Page
      title="Service Handover"
      subtitle={
        staff
          ? 'Every site and the state of its handover pack. Open a site to generate its draft, work through its outstanding actions and issue it.'
          : 'Every site and its issued handover pack. Open a site to download it.'
      }
      actions={
        staff && (
          <div className={cs.rowActions}>
            <Button onClick={() => setActionsOpen(true)}>Outstanding actions</Button>
            <Button onClick={() => setNotesOpen(true)}>Edit notes</Button>
          </div>
        )
      }
    >
      {actionError && <LoadError message={actionError} />}
      <Card>
        <div className={ls.toolbar}>
          <SearchBox
            size="small"
            className={ls.search}
            placeholder="Search site code, name, country, region or PM"
            value={search}
            onChange={(_, d) => setSearch(d.value)}
            aria-label="Search sites"
          />
          <Select size="small" value={statusFilter} onChange={(_, d) => setStatusFilter(d.value as HandoverSiteStatus | '')} aria-label="Status">
            <option value="">Every status ({sitesQ.data?.length ?? 0})</option>
            {(Object.keys(HANDOVER_SITE_STATUS_LABELS) as HandoverSiteStatus[]).map((k) => (
              <option key={k} value={k}>
                {HANDOVER_SITE_STATUS_LABELS[k]} ({counts[k] ?? 0})
              </option>
            ))}
          </Select>
          {staff && <Checkbox label="Open actions only" checked={openOnly} onChange={(_, d) => setOpenOnly(!!d.checked)} />}
        </div>
        {sitesQ.isLoading ? (
          <TableSkeleton rows={5} cols={6} label="Loading sites" />
        ) : (sitesQ.data?.length ?? 0) === 0 ? (
          <EmptyState title="No sites yet" hint="Add sites in Site Data; each one gets its own handover pack." />
        ) : sorted.length === 0 ? (
          <EmptyState title="No sites match" hint="Clear the search or a filter." />
        ) : (
          <DataTable size="small" minWidth={staff ? 900 : 720}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell {...header('sitecode')}>Site code</TableHeaderCell>
                <TableHeaderCell {...header('name')}>Name</TableHeaderCell>
                <TableHeaderCell {...header('country')}>Country</TableHeaderCell>
                <TableHeaderCell {...header('status')}>Status</TableHeaderCell>
                <TableHeaderCell {...header('changed')}>Last change</TableHeaderCell>
                {staff && <TableHeaderCell {...header('actions')}>Outstanding actions</TableHeaderCell>}
                <TableHeaderCell {...header('pm')}>Provider PM</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <RowLink to={`/handover/sites/${r.id}`}>{r.sitecode}</RowLink>
                  </TableCell>
                  <TableCell>{r.name || '—'}</TableCell>
                  <TableCell>{r.country || '—'}</TableCell>
                  <TableCell>
                    <SiteStatusBadge row={r} />
                    {r.status === 'draft' && r.issuedVersion && (
                      <Text size={100} block className={ls.muted}>
                        {r.issuedVersion} issued
                      </Text>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.lastChange ? (
                      <>
                        <Text size={200} block>
                          {r.lastChange.what === 'issued' ? 'Issued' : 'Generated'} {whenShort(r.lastChange.at)}
                        </Text>
                        {r.lastChange.by && (
                          <Text size={100} className={ls.muted}>
                            by {r.lastChange.by}
                          </Text>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  {staff && (
                    <TableCell>
                      {!r.actions || r.actions.total === 0 ? (
                        <Text size={200} className={ls.muted}>
                          No
                        </Text>
                      ) : r.actions.open === 0 ? (
                        <Badge appearance="tint" color="success">
                          Yes: all done
                        </Badge>
                      ) : (
                        <Badge appearance="tint" color="warning">
                          Yes: {r.actions.open} open of {r.actions.total}
                        </Badge>
                      )}
                    </TableCell>
                  )}
                  <TableCell>{r.providerPms.length ? r.providerPms.join(', ') : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Card>

      {(staff || groupPacks.length > 0) && (
        <Card>
          <div className={ls.cardHead}>
            <div>
              <Text weight="semibold" size={400} block>
                Packs covering several sites
              </Text>
              <Text size={200} className={ls.muted}>
                One pack for every site, or for a group of sites. These have their own version numbers and don&apos;t change any site&apos;s status.
              </Text>
            </div>
            {staff && <Button onClick={() => setGenerateOpen(true)}>Generate a pack for several sites</Button>}
          </div>
          {packs.isLoading ? (
            <TableSkeleton rows={2} cols={5} />
          ) : groupPacks.length === 0 ? (
            <Text size={200} className={ls.muted}>
              None yet.
            </Text>
          ) : (
            <PackTable
              packs={groupPacks}
              showScope
              canIssue={canIssue}
              onPreview={(p) => setPreviewId(p.id)}
              onDownload={(p) => downloadPack(activeTenantId, p).catch((e) => setActionError(errorMessage(e, 'Could not download the file')))}
              onIssue={setIssuing}
              onUpload={staff ? setUploadBase : undefined}
            />
          )}
        </Card>
      )}
      {uploadBase && <UploadDialog tenantId={activeTenantId} base={uploadBase} packs={packs.data ?? []} onClose={() => setUploadBase(null)} onDone={refresh} />}

      {generateOpen && (
        <GenerateDialog
          tenantId={activeTenantId}
          sites={sites}
          lastProject={[...(packs.data ?? [])].sort((a, b) => b.version - a.version)[0]?.source?.projectName ?? ''}
          onClose={() => setGenerateOpen(false)}
          onDone={() => {
            setGenerateOpen(false);
            refresh();
          }}
        />
      )}
      {notesOpen && <NotesDialog tenantId={activeTenantId} sites={sites} onClose={() => setNotesOpen(false)} />}
      {actionsOpen && (
        <HandoverActionsDialog
          tenantId={activeTenantId}
          sites={sites}
          canEdit={staff}
          onClose={() => {
            setActionsOpen(false);
            refresh();
          }}
        />
      )}
      {previewId && <PreviewDialog tenantId={activeTenantId} packId={previewId} onClose={() => setPreviewId(null)} />}
      {issuing && (
        <IssueDialog
          tenantId={activeTenantId}
          pack={issuing}
          packs={packs.data ?? []}
          onClose={() => setIssuing(null)}
          onIssued={refresh}
          onError={(m) => setActionError(m)}
        />
      )}
    </Page>
  );
}

/** Packs as a table: version, (scope), status, created, and preview / download / issue. */
export function PackTable({
  packs,
  showScope,
  minWidth,
  canIssue,
  onPreview,
  onDownload,
  onIssue,
  onUpload,
}: {
  packs: Pack[];
  showScope?: boolean;
  minWidth?: number;
  canIssue: boolean;
  onPreview: (p: Pack) => void;
  onDownload: (p: Pack) => void;
  onIssue: (p: Pack) => void;
  /** staff: upload a copy of this version edited in Word */
  onUpload?: (p: Pack) => void;
}) {
  const cs = useStyles();
  return (
    <DataTable size="small" minWidth={minWidth ?? (showScope ? 760 : 640)}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Version</TableHeaderCell>
          {showScope && <TableHeaderCell>Sites</TableHeaderCell>}
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Generated</TableHeaderCell>
          <TableHeaderCell>What changed</TableHeaderCell>
          <TableHeaderCell>Actions</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {packs.map((p) => (
          <TableRow key={p.id}>
            <TableCell>
              {packVersion(p)}
              {p.source?.origin === 'uploaded' && (
                <Text size={100} block>
                  Edited in Word
                </Text>
              )}
            </TableCell>
            {showScope && <TableCell>{handoverScopeLabel(p.source?.siteCodes)}</TableCell>}
            <TableCell>
              <Badge appearance="tint" color={p.status === 'issued' ? 'success' : 'informative'}>
                {p.status === 'issued' ? 'Issued' : 'Draft'}
              </Badge>
              {p.issued_at && (
                <Text size={100} block>
                  {whenShort(p.issued_at)}
                  {p.issued_by_name ? ` by ${p.issued_by_name}` : ''}
                </Text>
              )}
            </TableCell>
            <TableCell>
              {whenShort(p.generated_at ?? p.created_at)}
              {p.generated_by_name && (
                <Text size={100} block>
                  by {p.generated_by_name}
                </Text>
              )}
            </TableCell>
            <TableCell>{p.source?.changeNote || (p.source?.uploadedFrom ? `Edited copy of ${p.source.uploadedFrom.version}` : '—')}</TableCell>
            <TableCell>
              <div className={cs.rowActions}>
                {p.source?.origin !== 'uploaded' && <Link onClick={() => onPreview(p)}>Preview</Link>}
                {p.file_id && <Link onClick={() => onDownload(p)}>Download .docx</Link>}
                {canIssue && p.status === 'draft' && p.file_id && <Link onClick={() => onIssue(p)}>Issue</Link>}
                {onUpload && <Link onClick={() => onUpload(p)}>Upload edited copy</Link>}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </DataTable>
  );
}

/** Issues a draft: who approved it is printed in the pack's Approvals & Sign-Off section. */
export function IssueDialog({
  tenantId,
  pack,
  packs,
  onClose,
  onIssued,
  onError,
}: {
  tenantId: string;
  pack: Pack;
  /** every pack, to work out the version it is issued as */
  packs: Pack[];
  onClose: () => void;
  onIssued: () => void;
  onError: (message: string) => void;
}) {
  const cs = useStyles();
  const uploaded = pack.source?.origin === 'uploaded';
  const [approval, setApproval] = useState({ company: '', name: '', date: new Date().toISOString().slice(0, 10) });
  const issue = useMutation({
    mutationFn: () =>
      api(`/t/${tenantId}/handover/packs/${pack.id}/issue`, {
        method: 'POST',
        body: JSON.stringify(uploaded ? {} : { approverCompany: approval.company.trim() || undefined, approverName: approval.name.trim() || undefined, approvalDate: approval.date || undefined }),
      }),
    onSuccess: () => {
      onClose();
      onIssued();
    },
    onError: (e) => {
      onClose();
      onError(errorMessage(e, 'Could not issue the pack'));
    },
  });
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Issue version {issuedHandoverVersionLabel(pack.version_label, packs.filter((x) => sameHandoverScope(x.source?.siteIds, pack.source?.siteIds)))}?</DialogTitle>
          <DialogContent className={cs.stack}>
            <Text block>
              This marks the pack as final and records who issued it and when. It can&apos;t be undone. To change anything afterwards, generate a new version.
            </Text>
            {uploaded ? (
              <Text block size={200}>
                This version was edited in Word and uploaded, so it&apos;s issued exactly as uploaded: Voxshift only takes out its DRAFT markings and
                sets the version. Check its Approvals &amp; Sign-Off and Document Control in Word before you issue it; if anything still says DRAFT,
                it won&apos;t be issued.
              </Text>
            ) : (
              <>
            <Text block size={200}>
              Who approved and signed it off is printed in the pack&apos;s Approvals &amp; Sign-Off section.
            </Text>
            <Field label="Approved by: company" hint="Leave empty for the company whose branding the pack carries.">
              <Input value={approval.company} maxLength={120} onChange={(_, d) => setApproval((a) => ({ ...a, company: d.value }))} />
            </Field>
            <Field label="Approved by: name and title" hint="For example “Alex Example, Contoso, Director EMEA”.">
              <Input value={approval.name} maxLength={200} onChange={(_, d) => setApproval((a) => ({ ...a, name: d.value }))} />
            </Field>
            <Field label="Date approved">
              <Input type="date" value={approval.date} onChange={(_, d) => setApproval((a) => ({ ...a, date: d.value }))} />
            </Field>
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={issue.isPending} onClick={() => issue.mutate()}>
              {issue.isPending ? 'Issuing…' : 'Issue pack'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/**
 * Upload a copy of a pack edited in Word (docs/HANDOVER-VIEW.md step 3). It becomes the next version of the same sites' pack, a draft
 * issued the usual way.
 */
export function UploadDialog({ tenantId, base, packs, onClose, onDone }: { tenantId: string; base: Pack; packs: Pack[]; onClose: () => void; onDone: () => void }) {
  const cs = useStyles();
  const [file, setFile] = useState<File | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const next = nextHandoverVersionLabel(packs.filter((p) => sameHandoverScope(p.source?.siteIds, base.source?.siteIds)));
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('file', file!);
      if (changeNote.trim()) form.append('changeNote', changeNote.trim());
      return api(`/t/${tenantId}/handover/packs/${base.id}/upload`, { method: 'POST', body: form });
    },
    onSuccess: () => {
      onClose();
      onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Upload an edited copy of {packVersion(base)}</DialogTitle>
          <DialogContent className={cs.stack}>
            <Text size={200}>
              Download version {packVersion(base)}, make your changes in Word and upload it here. It becomes version {next} (draft) of{' '}
              {handoverScopeLabel(base.source?.siteCodes)}&apos;s pack. When it&apos;s final, issue it as usual: it&apos;s issued as you uploaded it,
              with only its DRAFT markings taken out.
            </Text>
            <Field label="Edited document" hint="A Word document (.docx), up to 25 MB.">
              <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <Field label="What changed in this version (optional)" hint="Shown under Versions, and in the Document Control of packs generated later.">
              <Input value={changeNote} maxLength={300} onChange={(_, d) => setChangeNote(d.value)} />
            </Field>
            {upload.isError && <DangerText>{errorMessage(upload.error, 'Could not upload the document')}</DangerText>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
              {upload.isPending ? 'Uploading…' : `Upload as ${next}`}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------------ generate ------------------------------ */

export function GenerateDialog({
  tenantId,
  sites,
  fixedSite,
  uploadedLatest,
  lastProject,
  onClose,
  onDone,
}: {
  tenantId: string;
  sites: SiteOption[];
  /** a site's own page: the pack is for this site, and there's no choosing */
  fixedSite?: SiteOption;
  /** the site's newest version, when it was edited in Word and uploaded: a new draft from data won't have those edits */
  uploadedLatest?: string;
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
  const drawDiagrams = async (): Promise<{ diagrams: { name: string; fileId: string; pdfFileId?: string; width: number; height: number }[]; failed: string[] }> => {
    const out: { name: string; fileId: string; pdfFileId?: string; width: number; height: number }[] = [];
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
        // the same diagram as a PDF, embedded in the pack under the picture (the server makes one from the picture if this fails)
        const pdf = shot.pdf ? await apiUpload<{ fileId: string }>(`/t/${tenantId}/handover/diagrams`, new File([shot.pdf], `call-flow-${g.name}.pdf`, { type: 'application/pdf' })).catch(() => null) : null;
        out.push({ name: g.name, fileId: up.fileId, ...(pdf ? { pdfFileId: pdf.fileId } : {}), width: shot.width, height: shot.height });
      } catch {
        failed.push(g.name);
      }
    }
    setDrawing(null);
    return { diagrams: out, failed };
  };
  const [mode, setMode] = useState<'all' | 'sites'>(fixedSite ? 'sites' : 'all');
  const [siteIds, setSiteIds] = useState<Set<string>>(new Set(fixedSite ? [fixedSite.id] : []));
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
          <DialogTitle>{fixedSite ? `Generate a draft for ${fixedSite.sitecode}` : 'Generate a pack for several sites'}</DialogTitle>
          <DialogContent className={cs.stack}>
            {uploadedLatest && (
              <MessageBar intent="warning" layout="multiline">
                <MessageBarBody>
                  <MessageBarTitle>Version {uploadedLatest} was edited in Word</MessageBarTitle>
                  A new draft is made from Voxshift&apos;s data, so it won&apos;t have those edits. Version {uploadedLatest} stays under Versions to
                  download.
                </MessageBarBody>
              </MessageBar>
            )}
            {fixedSite ? (
              <Text size={200}>
                A new draft of {fixedSite.name && fixedSite.name !== fixedSite.sitecode ? `${fixedSite.sitecode} ${fixedSite.name}` : fixedSite.sitecode}&apos;s pack, from
                what&apos;s live in Teams now and the site&apos;s notes and open actions.
              </Text>
            ) : (
              <>
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
            </>
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
            <Field label="Project name (optional)" hint="Printed on the front page under the customer's name, for example “Contoso Global Teams Project”.">
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
                {generate.isPending ? 'Generating…' : fixedSite ? 'Generate draft' : 'Generate pack'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ------------------------------- notes ------------------------------- */

export function NotesDialog({ tenantId, sites, initialSiteId = '', onClose }: { tenantId: string; sites: SiteOption[]; /** '' = every site */ initialSiteId?: string; onClose: () => void }) {
  const cs = useStyles();
  const qc = useQueryClient();
  const notesQ = useQuery({
    queryKey: ['handover-notes', tenantId],
    queryFn: () => api<Note[]>(`/t/${tenantId}/handover/notes`),
  });
  const notes = notesQ.data ?? [];

  const [section, setSection] = useState<HandoverNoteSection>(HANDOVER_NOTE_SECTIONS[0]);
  const [siteId, setSiteId] = useState(initialSiteId); // '' = every site
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

export function PreviewDialog({ tenantId, packId, onClose }: { tenantId: string; packId: string; onClose: () => void }) {
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
export function packVersion(p: Pack): string {
  return p.version_label ?? String(p.version);
}
