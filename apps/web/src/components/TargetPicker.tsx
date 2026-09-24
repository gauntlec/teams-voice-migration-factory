import { useState } from 'react';
import { Combobox, Dropdown, Field, Input, Option, Text, Textarea } from '@fluentui/react-components';
import type { WizardTarget } from '@tvmf/shared';
import { CallQueueWizard } from './CallQueueWizard';
import { UpnAutocomplete } from './UpnAutocomplete';
import type { Choice } from './records';

/** A `Choice` for the "team" destination picker - `flowId` is set when this points at a not-yet-imported planned capture (linked by id, see wizard-convert.ts's resolveFlow) rather than an already-built row (matched later by name). Defined here (not WizardTiles.tsx, which imports AutoAttendantWizard which imports this file) to avoid a module cycle. */
export interface TeamChoice extends Choice {
  flowId?: string;
}

const TARGET_KIND_LABELS: Record<WizardTarget['kind'], string> = {
  person: 'A person',
  team: 'A department / team',
  message: 'Play a recorded message',
  voicemail: 'Voicemail',
  external: 'An outside phone number',
  operator: 'Talk to the operator',
  call_queue: 'Set up a new call queue',
};

const DEFAULT_KINDS: WizardTarget['kind'][] = ['person', 'team', 'message', 'voicemail', 'external', 'operator', 'call_queue'];

/**
 * "Where should this call go?" - the AA/CQ creation wizard's one routing
 * control, shared by every step that asks it (menu options, direct
 * transfers, exception handling). `kinds` narrows the offered list where a
 * step's underlying cmdlet can't support every kind (e.g. an operator can't
 * itself point at "the operator"). `allowNone` adds a "— none —" choice for
 * optional targets (the AA's own Operator field).
 *
 * "A person"/"A department" both suggest from what's already synced
 * (`UpnAutocomplete`'s live tenant-user search; `teamChoices`, this site's
 * existing Call Queues/Auto Attendants) while staying freeform, so a name
 * that isn't synced yet can still be typed and carried through - see
 * wizard-convert.ts's own resolvePerson/resolveTeam, which the import step
 * matches these same labels against.
 *
 * "Set up a new call queue" is different: it doesn't accept typed text at
 * all. Picking it opens the Call Queue wizard nested on top of this one;
 * completing it creates a real discovery_flows row and links this target to
 * it by id (`flowId`), which wizard-convert.ts's resolveFlow resolves
 * directly - no name-matching involved. Cancelling the nested wizard
 * reverts the target to whatever it was before, so a destination is never
 * left half-set. Only offered when `base`/`tenantId`/`siteId` are all
 * available, since - unlike every other kind - it has no freeform fallback.
 */
export function TargetPicker({
  value,
  onChange,
  kinds = DEFAULT_KINDS,
  allowNone,
  base,
  tenantId,
  siteId,
  teamChoices,
  onFlowCreated,
}: {
  value: WizardTarget | undefined;
  onChange: (v: WizardTarget | undefined) => void;
  kinds?: WizardTarget['kind'][];
  allowNone?: boolean;
  /** Tenant-scoped Data Collection API base (e.g. `/t/:tenantId/discovery`) - needed only for the "Set up a new call queue" kind's nested wizard. */
  base?: string;
  /** Enables live-matching against synced tenant users for kind 'person'. */
  tenantId?: string;
  /** Also suggests this site's own Data Collection Users tab entries, not just the live tenant sync. */
  siteId?: string;
  /** This site's existing Call Queue/Auto Attendant names, suggested for kind 'team'. */
  teamChoices?: TeamChoice[];
  /** Called after the nested "Set up a new call queue" wizard creates a row, so the caller can refresh its own Call flows list the same way the top-level wizard tiles already do. */
  onFlowCreated?: () => void;
}) {
  const kind = value?.kind ?? '';
  const needsLabel = kind === 'person' || kind === 'team' || kind === 'message' || kind === 'external';
  const canCreateCallQueue = !!(base && tenantId && siteId);
  const offeredKinds = kinds.filter((k) => k !== 'call_queue' || canCreateCallQueue);

  const [nestedOpen, setNestedOpen] = useState(false);
  const [prevValue, setPrevValue] = useState<WizardTarget | undefined>(undefined);

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
      <Field label="Where should this go?">
        <Dropdown
          value={kind ? TARGET_KIND_LABELS[kind as WizardTarget['kind']] : allowNone ? '— none —' : '— choose —'}
          selectedOptions={kind ? [kind] : ['']}
          onOptionSelect={(_, d) => {
            const k = (d.optionValue || '') as WizardTarget['kind'] | '';
            if (k === 'call_queue') {
              setPrevValue(value);
              onChange({ kind: 'call_queue' });
              setNestedOpen(true);
              return;
            }
            onChange(k ? { kind: k, label: '' } : undefined);
          }}
          style={{ minWidth: 220 }}
        >
          {allowNone && <Option value="">— none —</Option>}
          {offeredKinds.map((k) => (
            <Option key={k} value={k}>
              {TARGET_KIND_LABELS[k]}
            </Option>
          ))}
        </Dropdown>
      </Field>
      {kind === 'call_queue' ? (
        <Field label="Call queue">
          <Text size={200}>{value?.flowId ? `"${value.label}" (created)` : 'Setting up…'}</Text>
        </Field>
      ) : kind === 'message' ? (
        <Field label="What should we say?">
          <Textarea
            value={value?.label ?? ''}
            onChange={(_, d) => onChange({ kind: 'message', label: d.value })}
            style={{ minWidth: 260 }}
          />
        </Field>
      ) : kind === 'person' && tenantId ? (
        <Field label="Name or email">
          <UpnAutocomplete
            tenantId={tenantId}
            siteId={siteId}
            value={value?.label ?? ''}
            onChange={(v) => onChange({ kind: 'person', label: v })}
            style={{ minWidth: 220 }}
          />
        </Field>
      ) : kind === 'team' && teamChoices?.length ? (
        <Field label="Department / team name">
          <Combobox
            freeform
            value={value?.label ?? ''}
            style={{ minWidth: 220 }}
            onChange={(e) => onChange({ kind: 'team', label: e.target.value })}
            onOptionSelect={(_, d) => {
              const picked = teamChoices.find((c) => c.value === d.optionValue);
              onChange({ kind: 'team', label: picked?.label ?? d.optionText ?? d.optionValue ?? '', flowId: picked?.flowId });
            }}
          >
            {teamChoices.map((c) => (
              <Option key={c.value} value={c.value} text={c.label}>
                {c.label}
                {c.flowId ? ' (planned)' : ''}
              </Option>
            ))}
          </Combobox>
        </Field>
      ) : needsLabel ? (
        <Field label={kind === 'person' ? 'Name or email' : kind === 'team' ? 'Department / team name' : 'Phone number'}>
          <Input
            value={value?.label ?? ''}
            placeholder={kind === 'external' ? '+1 555 123 4567' : undefined}
            onChange={(_, d) => onChange({ kind: kind as WizardTarget['kind'], label: d.value })}
            style={{ minWidth: 200 }}
          />
        </Field>
      ) : null}
      {canCreateCallQueue && (
        <CallQueueWizard
          open={nestedOpen}
          onOpenChange={(o) => {
            setNestedOpen(o);
            if (!o) onChange(prevValue);
          }}
          base={base!}
          tenantId={tenantId!}
          siteId={siteId!}
          resourceAccountChoices={[]}
          onCreated={(row) => {
            if (row) {
              onChange({ kind: 'call_queue', label: row.name, flowId: row.id });
              onFlowCreated?.();
            }
          }}
        />
      )}
    </div>
  );
}
