import { Dropdown, Field, Input, Option, Textarea } from '@fluentui/react-components';
import type { WizardTarget } from '@tvmf/shared';

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
 */
export function TargetPicker({
  value,
  onChange,
  kinds = DEFAULT_KINDS,
  allowNone,
}: {
  value: WizardTarget | undefined;
  onChange: (v: WizardTarget | undefined) => void;
  kinds?: WizardTarget['kind'][];
  allowNone?: boolean;
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
      {needsLabel && kind === 'message' ? (
        <Field label="What should we say?">
          <Textarea
            value={value?.label ?? ''}
            onChange={(_, d) => onChange({ kind: 'message', label: d.value })}
            style={{ minWidth: 260 }}
          />
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
