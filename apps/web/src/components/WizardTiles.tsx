import { useState } from 'react';
import { Card, CardHeader, Text, makeStyles, shorthands } from '@fluentui/react-components';
import { AutoAttendantWizard } from './AutoAttendantWizard';
import { CallQueueWizard } from './CallQueueWizard';
import type { Choice } from './records';

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
  siteId,
  resourceAccountChoices,
  onCreated,
}: {
  base: string;
  siteId: string;
  resourceAccountChoices: Choice[];
  onCreated: () => void;
}) {
  const s = useStyles();
  const [open, setOpen] = useState<WizardTileDef['key'] | null>(null);

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
        siteId={siteId}
        resourceAccountChoices={resourceAccountChoices}
        onCreated={onCreated}
      />
      <CallQueueWizard
        open={open === 'call-queue'}
        onOpenChange={(o) => setOpen(o ? 'call-queue' : null)}
        base={base}
        siteId={siteId}
        resourceAccountChoices={resourceAccountChoices}
        onCreated={onCreated}
      />
    </>
  );
}
