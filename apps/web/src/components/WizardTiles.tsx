import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, Text, makeStyles, shorthands } from '@fluentui/react-components';
import type { Paginated } from '@tvmf/shared';
import { api } from '../api';
import { AutoAttendantWizard } from './AutoAttendantWizard';
import { CallQueueWizard } from './CallQueueWizard';
import type { Choice } from './records';
import type { TeamChoice } from './TargetPicker';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', ...shorthands.gap('12px') },
  card: { ...shorthands.padding('14px'), cursor: 'pointer' },
});

interface WizardTileDef {
  key: 'auto-attendant' | 'call-queue';
  title: string;
  desc: string;
}

/**
 * "A department/team" suggestions for the wizard's "where should this go?"
 * picker: this site's own already-built Call Queues/Auto Attendants (so it
 * can match, and at import actually link to, something real instead of
 * always leaving it as a free-text guess) plus this site's *planned*
 * captures - Call flows rows already made via either wizard but not yet
 * imported to Design & Build. A planned pick carries `flowId`, resolved by
 * id rather than name-matching, so it stays correct even if the capture is
 * later renamed. Exported so SiteWorkspace.tsx's "edit a wizard-captured
 * row" flow (outside this tile grid) can reuse the exact same query/cache
 * instead of duplicating it.
 */
export function useTeamChoices(tenantId: string, siteId: string): TeamChoice[] {
  const cqs = useQuery({
    queryKey: ['wizard-team-cqs', tenantId, siteId],
    enabled: !!tenantId && !!siteId,
    queryFn: () => api<Paginated<{ id: string; name: string }>>(`/t/${tenantId}/build/call-queues?siteId=${siteId}&limit=500`),
  });
  const aas = useQuery({
    queryKey: ['wizard-team-aas', tenantId, siteId],
    enabled: !!tenantId && !!siteId,
    queryFn: () => api<Paginated<{ id: string; name: string }>>(`/t/${tenantId}/build/auto-attendants?siteId=${siteId}&limit=500`),
  });
  const planned = useQuery({
    queryKey: ['wizard-team-planned-flows', tenantId, siteId],
    enabled: !!tenantId && !!siteId,
    queryFn: () =>
      api<Paginated<{ id: string; name: string; kind: string; wizard_answers: unknown; imported_at: string | null }>>(
        `/t/${tenantId}/discovery/flows?siteId=${siteId}&limit=500`,
      ),
  });
  return useMemo(() => {
    const built: TeamChoice[] = [...(cqs.data?.items ?? []), ...(aas.data?.items ?? [])].map((r) => ({ value: r.name, label: r.name }));
    const plannedChoices: TeamChoice[] = (planned.data?.items ?? [])
      .filter((f) => (f.kind === 'call_queue' || f.kind === 'auto_attendant') && f.wizard_answers != null && f.imported_at == null)
      .map((f) => ({ value: f.id, label: f.name, flowId: f.id }));
    return [...built, ...plannedChoices];
  }, [cqs.data, aas.data, planned.data]);
}

/**
 * "Guided setup" - a small, data-driven tile grid above the site workspace's
 * tab bar (Data Collection's "Discovery" site page). Each tile launches a
 * multi-step wizard that captures Auto Attendant/Call Queue requirements in
 * plain language and saves them onto a Call flows row (see the "Auto
 * Attendant / Call Queue Creation Wizard" plan). Adding a future wizard is
 * one entry in `TILES` plus its own dialog component - the grid itself
 * doesn't change.
 */
const TILES: WizardTileDef[] = [
  { key: 'auto-attendant', title: 'New Auto Attendant', desc: 'Build a phone menu that greets callers and routes them by the button they press.' },
  { key: 'call-queue', title: 'New Call Queue', desc: 'Set up a group of people who share incoming calls, like a support or sales line.' },
];

export function WizardTiles({
  base,
  tenantId,
  siteId,
  resourceAccountChoices,
  onCreated,
}: {
  base: string;
  tenantId: string;
  siteId: string;
  resourceAccountChoices: Choice[];
  onCreated: () => void;
}) {
  const s = useStyles();
  const [open, setOpen] = useState<WizardTileDef['key'] | null>(null);
  const teamChoices = useTeamChoices(tenantId, siteId);

  return (
    <>
      <Text weight="semibold">Guided setup</Text>
      <div className={s.grid}>
        {TILES.map((tile) => (
          <Card key={tile.key} className={s.card} onClick={() => setOpen(tile.key)}>
            <CardHeader header={<Text weight="semibold">{tile.title}</Text>} />
            <Text size={200}>{tile.desc}</Text>
          </Card>
        ))}
      </div>
      <AutoAttendantWizard
        open={open === 'auto-attendant'}
        onOpenChange={(o) => setOpen(o ? 'auto-attendant' : null)}
        base={base}
        tenantId={tenantId}
        siteId={siteId}
        resourceAccountChoices={resourceAccountChoices}
        teamChoices={teamChoices}
        onCreated={onCreated}
      />
      <CallQueueWizard
        open={open === 'call-queue'}
        onOpenChange={(o) => setOpen(o ? 'call-queue' : null)}
        base={base}
        tenantId={tenantId}
        siteId={siteId}
        resourceAccountChoices={resourceAccountChoices}
        onCreated={onCreated}
      />
    </>
  );
}
