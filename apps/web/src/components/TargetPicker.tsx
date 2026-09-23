import { Combobox, Dropdown, Field, Input, Option, Textarea } from '@fluentui/react-components';
import type { WizardTarget } from '@tvmf/shared';
import { UpnAutocomplete } from './UpnAutocomplete';
import type { Choice } from './records';

const TARGET_KIND_LABELS: Record<WizardTarget['kind'], string> = {
  person: 'A person',
  team: 'A department / team',
  message: 'Play a recorded message',
  voicemail: 'Voicemail',
  external: 'An outside phone number',
  operator: 'Talk to the operator',
};

const DEFAULT_KINDS: WizardTarget['kind'][] = ['person', 'team', 'message', 'voicemail', 'external', 'operator'];

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
 */
export function TargetPicker({
  value,
  onChange,
  kinds = DEFAULT_KINDS,
  allowNone,
  tenantId,
  teamChoices,
}: {
  value: WizardTarget | undefined;
  onChange: (v: WizardTarget | undefined) => void;
  kinds?: WizardTarget['kind'][];
  allowNone?: boolean;
  /** Enables live-matching against synced tenant users for kind 'person'. */
  tenantId?: string;
  /** This site's existing Call Queue/Auto Attendant names, suggested for kind 'team'. */
  teamChoices?: Choice[];
}) {
  const kind = value?.kind ?? '';
  const needsLabel = kind === 'person' || kind === 'team' || kind === 'message' || kind === 'external';

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
      <Field label="Where should this go?">
        <Dropdown
          value={kind ? TARGET_KIND_LABELS[kind as WizardTarget['kind']] : allowNone ? '— none —' : '— choose —'}
          selectedOptions={kind ? [kind] : ['']}
          onOptionSelect={(_, d) => {
            const k = (d.optionValue || '') as WizardTarget['kind'] | '';
            onChange(k ? { kind: k, label: '' } : undefined);
          }}
          style={{ minWidth: 220 }}
        >
          {allowNone && <Option value="">— none —</Option>}
          {kinds.map((k) => (
            <Option key={k} value={k}>
              {TARGET_KIND_LABELS[k]}
            </Option>
          ))}
        </Dropdown>
      </Field>
      {kind === 'message' ? (
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
            onOptionSelect={(_, d) => onChange({ kind: 'team', label: d.optionText ?? d.optionValue ?? '' })}
          >
            {teamChoices.map((c) => (
              <Option key={c.value} value={c.value} text={c.label}>
                {c.label}
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
    </div>
  );
}
