import { useMemo, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowLeftRegular } from '@fluentui/react-icons';
import { HANDOVER_SECTIONS, sameHandoverScope, type HandoverNoteSection } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { Page } from '../../components/Page';
import { EmptyState, TableSkeleton } from '../../components/states';
import { LoadError, NoTenant } from '../DataCollection';
import {
  downloadPack,
  GenerateDialog,
  IssueDialog,
  NotesDialog,
  PackTable,
  packVersion,
  PreviewDialog,
  SiteStatusBadge,
  useHandoverPacks,
  useHandoverSites,
  whenShort,
  type Pack,
  UploadDialog,
} from '../Handover';
import { HandoverActionsPanel } from './handoverActions';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalL },
  summary: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalXXL, rowGap: tokens.spacingVerticalS },
  fact: { display: 'flex', flexDirection: 'column', rowGap: '2px' },
  label: { color: tokens.colorNeutralForeground3 },
  buttons: { display: 'flex', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalM },
  cardHead: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalS },
  notes: { display: 'grid', gridTemplateColumns: 'minmax(160px, 240px) minmax(80px, 110px) 1fr', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXS },
  noteRow: { display: 'contents' },
  clip: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
});

interface Note {
  id: string;
  section_key: HandoverNoteSection;
  site_id: string | null;
  body: string;
}

const SECTION_TITLE = Object.fromEntries(HANDOVER_SECTIONS.map((s) => [s.key, s.title])) as Record<string, string>;

/**
 * One site's Service Handover (docs/HANDOVER-VIEW.md): its pack's status, every version, and for staff generating a draft, issuing
 * it, the site's outstanding actions and its notes. Customer users see the issued versions only.
 */
export function HandoverSite() {
  const { siteId = '' } = useParams();
  const { activeTenantId, can } = useAuth();
  const qc = useQueryClient();
  const s = useStyles();
  const staff = can('handover:generate');
  const canIssue = can('handover:issue');
  const [generateOpen, setGenerateOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [issuing, setIssuing] = useState<Pack | null>(null);
  const [uploadBase, setUploadBase] = useState<Pack | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sitesQ = useHandoverSites(activeTenantId);
  const packsQ = useHandoverPacks(activeTenantId);
  const notesQ = useQuery({
    queryKey: ['handover-notes', activeTenantId],
    enabled: !!activeTenantId && staff,
    queryFn: () => api<Note[]>(`/t/${activeTenantId}/handover/notes`),
  });
  const row = sitesQ.data?.find((r) => r.id === siteId);
  const sites = useMemo(() => (sitesQ.data ?? []).map((r) => ({ id: r.id, sitecode: r.sitecode, name: r.name })), [sitesQ.data]);
  const site = sites.find((x) => x.id === siteId);
  const packs = (packsQ.data ?? []).filter((p) => sameHandoverScope(p.source?.siteIds, [siteId]));
  const latest = packs[0];
  const notes = (notesQ.data ?? []).filter((n) => n.site_id === siteId || n.site_id === null);

  if (!activeTenantId) return <NoTenant />;
  if (sitesQ.isError) return <LoadError message={(sitesQ.error as Error).message} />;
  if (sitesQ.isLoading) return <Spinner label="Loading the site…" />;

  const back = (
    <RouterLink to="/handover">
      <Button appearance="subtle" icon={<ArrowLeftRegular />}>
        All sites
      </Button>
    </RouterLink>
  );
  if (!row || !site) {
    return (
      <Page title="Service Handover" actions={back}>
        <EmptyState title="Site not found" hint="It may have been deleted, or it belongs to another customer." />
      </Page>
    );
  }

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['handover', activeTenantId] });
    qc.invalidateQueries({ queryKey: ['handover-sites', activeTenantId] });
  };
  const download = (p: Pack) => downloadPack(activeTenantId, p).catch((e) => setError(e instanceof ApiError ? e.message : 'Could not download the file'));

  return (
    <Page title={row.name || row.sitecode} subtitle={`Service Handover · ${row.sitecode}`} actions={back}>
      <div className={s.stack}>
        {error && <LoadError message={error} />}
        <Card>
          <div className={s.summary}>
            <div className={s.fact}>
              <Text size={200} className={s.label}>
                Status
              </Text>
              <span>
                <SiteStatusBadge row={row} />
              </span>
            </div>
            {row.issuedVersion && row.status === 'draft' && (
              <div className={s.fact}>
                <Text size={200} className={s.label}>
                  Last issued
                </Text>
                <Text>{row.issuedVersion}</Text>
              </div>
            )}
            {row.lastChange && (
              <div className={s.fact}>
                <Text size={200} className={s.label}>
                  Last change
                </Text>
                <Text>
                  {row.lastChange.what === 'issued' ? 'Issued' : 'Generated'} {whenShort(row.lastChange.at)}
                  {row.lastChange.by ? ` by ${row.lastChange.by}` : ''}
                </Text>
              </div>
            )}
            <div className={s.fact}>
              <Text size={200} className={s.label}>
                Provider PM
              </Text>
              <Text>{row.providerPms.length ? row.providerPms.join(', ') : '—'}</Text>
            </div>
            {staff && row.actions && (
              <div className={s.fact}>
                <Text size={200} className={s.label}>
                  Outstanding actions
                </Text>
                <Text>{row.actions.total === 0 ? 'None' : row.actions.open === 0 ? 'All done' : `${row.actions.open} open of ${row.actions.total}`}</Text>
              </div>
            )}
          </div>
          <div className={s.buttons}>
            {staff && (
              <Button appearance="primary" onClick={() => setGenerateOpen(true)}>
                {latest ? 'Generate a new draft' : 'Generate the first draft'}
              </Button>
            )}
            {canIssue && latest?.status === 'draft' && latest.file_id && <Button onClick={() => setIssuing(latest)}>Issue draft {packVersion(latest)}</Button>}
            {/* customers are only sent issued packs, so for them the newest is the newest issued one */}
            {latest?.file_id && (
              <Button appearance={staff ? 'secondary' : 'primary'} onClick={() => download(latest)}>
                Download {packVersion(latest)}
              </Button>
            )}
            {staff && latest?.file_id && <Button onClick={() => setUploadBase(latest)}>Upload an edited copy</Button>}
            {latest && latest.source?.origin !== 'uploaded' && <Button onClick={() => setPreviewId(latest.id)}>Preview {packVersion(latest)}</Button>}
          </div>
        </Card>

        <Card>
          <Text weight="semibold" size={400}>
            Versions
          </Text>
          {packsQ.isLoading ? (
            <TableSkeleton rows={2} cols={5} />
          ) : packs.length === 0 ? (
            <Text size={200} className={s.muted}>
              {staff ? 'No pack for this site yet. Generate the first draft above.' : 'No pack has been issued for this site yet.'}
            </Text>
          ) : (
            <PackTable packs={packs} minWidth={720} canIssue={canIssue} onPreview={(p) => setPreviewId(p.id)} onDownload={download} onIssue={setIssuing} />
          )}
        </Card>

        {staff && (
          <Card>
            <Text weight="semibold" size={400}>
              Outstanding actions
            </Text>
            <HandoverActionsPanel tenantId={activeTenantId} sites={sites} site={site} canEdit={staff} />
          </Card>
        )}

        {staff && (
          <Card>
            <div className={s.cardHead}>
              <div>
                <Text weight="semibold" size={400} block>
                  Notes
                </Text>
                <Text size={200} className={s.muted}>
                  The sections Voxshift can&apos;t collect itself. A note for all sites prints in every pack; this site&apos;s only in its own.
                </Text>
              </div>
              <Button onClick={() => setNotesOpen(true)}>Edit notes</Button>
            </div>
            {notesQ.isLoading ? (
              <Spinner size="tiny" />
            ) : notes.length === 0 ? (
              <Text size={200} className={s.muted}>
                No notes yet.
              </Text>
            ) : (
              <div className={s.notes} role="list">
                {notes.map((n) => (
                  <div key={n.id} role="listitem" className={s.noteRow}>
                    <Text size={200} weight="semibold">
                      {SECTION_TITLE[n.section_key] ?? n.section_key}
                    </Text>
                    <Text size={200} className={s.muted}>
                      {n.site_id ? row.sitecode : 'All sites'}
                    </Text>
                    <Text size={200} className={s.clip} title={n.body}>
                      {n.body.split('\n')[0]}
                    </Text>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      {generateOpen && (
        <GenerateDialog
          tenantId={activeTenantId}
          sites={sites}
          fixedSite={site}
          uploadedLatest={latest?.source?.origin === 'uploaded' ? packVersion(latest) : undefined}
          lastProject={latest?.source?.projectName ?? [...(packsQ.data ?? [])].sort((a, b) => b.version - a.version)[0]?.source?.projectName ?? ''}
          onClose={() => setGenerateOpen(false)}
          onDone={() => {
            setGenerateOpen(false);
            refresh();
          }}
        />
      )}
      {notesOpen && <NotesDialog tenantId={activeTenantId} sites={sites} initialSiteId={site.id} onClose={() => setNotesOpen(false)} />}
      {previewId && <PreviewDialog tenantId={activeTenantId} packId={previewId} onClose={() => setPreviewId(null)} />}
      {uploadBase && <UploadDialog tenantId={activeTenantId} base={uploadBase} packs={packsQ.data ?? []} onClose={() => setUploadBase(null)} onDone={refresh} />}
      {issuing && <IssueDialog tenantId={activeTenantId} pack={issuing} packs={packsQ.data ?? []} onClose={() => setIssuing(null)} onIssued={refresh} onError={setError} />}
    </Page>
  );
}
