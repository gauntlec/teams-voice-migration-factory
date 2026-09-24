import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AddRegular,
  DeleteRegular,
} from '@fluentui/react-icons';
import {
  Button,
  Card,
  Checkbox,
  Dropdown,
  Field,
  Input,
  Option,
  Radio,
  RadioGroup,
  Text,
  Textarea,
} from '@fluentui/react-components';
import {
  AA_SUPPORTED_LANGUAGES,
  AA_TIME_ZONES,
  type AutoAttendantWizardAnswers,
  type WizardCallFlow,
  type WizardMenuOption,
  type WizardTarget,
  type WizardWeeklyHours,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { type Choice } from './records';
import { ResourceAccountCreateDialog } from './ResourceAccountCreateDialog';
import { TargetPicker, type TeamChoice } from './TargetPicker';
import { WizardShell, type WizardStep } from './WizardShell';

const AA_LANGUAGE_CHOICES: Choice[] = AA_SUPPORTED_LANGUAGES.map((l) => ({ value: l.code, label: l.label }));
const AA_TIME_ZONE_CHOICES: Choice[] = AA_TIME_ZONES.map((z) => ({ value: z.id, label: z.label }));

const DAYS: (keyof WizardWeeklyHours)[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

function emptyWeekly(): WizardWeeklyHours {
  return { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
}
const STANDARD_9_TO_5: WizardWeeklyHours = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
  saturday: [],
  sunday: [],
};

function WeeklyHoursEditor({ value, onChange }: { value: WizardWeeklyHours; onChange: (v: WizardWeeklyHours) => void }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {DAYS.map((d) => {
        const range = value[d][0];
        return (
          <div key={d} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ width: 90 }}>
              <Text size={200}>{DAY_LABELS[d]}</Text>
            </div>
            <Checkbox
              checked={!!range}
              label="Open"
              onChange={(_, c) => onChange({ ...value, [d]: c.checked ? [{ start: '09:00', end: '17:00' }] : [] })}
            />
            {range && (
              <>
                <Input
                  type="time"
                  value={range.start}
                  onChange={(_, ev) => onChange({ ...value, [d]: [{ ...range, start: ev.value }] })}
                  style={{ width: 120 }}
                />
                <Text size={200}>to</Text>
                <Input
                  type="time"
                  value={range.end}
                  onChange={(_, ev) => onChange({ ...value, [d]: [{ ...range, end: ev.value }] })}
                  style={{ width: 120 }}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

const MENU_KEYS = '0123456789'.split('');

function nextMenuKey(options: WizardMenuOption[]): string {
  const used = new Set(options.map((o) => o.key));
  return MENU_KEYS.find((k) => !used.has(k)) ?? String(options.length + 1);
}

/** The greeting + routing question shared by the business-hours, after-hours and holiday steps. */
function CallFlowEditor({
  value,
  onChange,
  allowVoicemail = true,
  base,
  tenantId,
  siteId,
  teamChoices,
  onFlowCreated,
}: {
  value: WizardCallFlow;
  onChange: (v: WizardCallFlow) => void;
  allowVoicemail?: boolean;
  base: string;
  tenantId: string;
  siteId: string;
  teamChoices: TeamChoice[];
  onFlowCreated: () => void;
}) {
  const options = value.options ?? [];
  const updateOption = (i: number, next: WizardMenuOption) => onChange({ ...value, options: options.map((o, idx) => (idx === i ? next : o)) });
  const addOption = () =>
    onChange({ ...value, options: [...options, { key: nextMenuKey(options), label: '', target: { kind: 'person', label: '' } }] });
  const removeOption = (i: number) => onChange({ ...value, options: options.filter((_, idx) => idx !== i) });

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Field label="What should we say when they call? (optional)">
        <Textarea
          value={value.greeting ?? ''}
          placeholder="Thanks for calling Contoso..."
          onChange={(_, d) => onChange({ ...value, greeting: d.value })}
        />
      </Field>
      <RadioGroup value={value.mode} onChange={(_, d) => onChange({ ...value, mode: d.value as WizardCallFlow['mode'] })}>
        <Radio value="menu" label="Offer callers a menu of choices" />
        <Radio value="direct" label="Send every call straight to one place" />
        {allowVoicemail && <Radio value="voicemail" label="Send every call to voicemail" />}
      </RadioGroup>
      {value.mode === 'menu' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <Checkbox
            checked={!!value.allowDialByName}
            label="Let callers reach someone by saying or typing their name"
            onChange={(_, d) => onChange({ ...value, allowDialByName: !!d.checked })}
          />
          {options.map((opt, i) => (
            <Card key={i} style={{ padding: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
                <Field label="Button">
                  <Input value={opt.key} style={{ width: 56 }} maxLength={1} onChange={(_, d) => updateOption(i, { ...opt, key: d.value.slice(0, 1) })} />
                </Field>
                <Field label="Option name">
                  <Input value={opt.label} placeholder="Sales" onChange={(_, d) => updateOption(i, { ...opt, label: d.value })} />
                </Field>
                <TargetPicker
                  value={opt.target}
                  onChange={(t) => updateOption(i, { ...opt, target: t ?? { kind: 'person', label: '' } })}
                  base={base}
                  tenantId={tenantId}
                  siteId={siteId}
                  teamChoices={teamChoices}
                  onFlowCreated={onFlowCreated}
                />
                <Button icon={<DeleteRegular />} appearance="subtle" aria-label="Remove option" onClick={() => removeOption(i)} />
              </div>
            </Card>
          ))}
          <Button size="small" icon={<AddRegular />} onClick={addOption} disabled={options.length >= 12}>
            Add option
          </Button>
        </div>
      )}
      {value.mode === 'direct' && (
        <TargetPicker
          value={value.target}
          onChange={(t) => onChange({ ...value, target: t })}
          kinds={['person', 'team', 'voicemail', 'external', 'operator', 'call_queue']}
          base={base}
          tenantId={tenantId}
          siteId={siteId}
          teamChoices={teamChoices}
          onFlowCreated={onFlowCreated}
        />
      )}
    </div>
  );
}

const targetSummary = (t: WizardTarget | undefined): string => {
  if (!t) return 'nowhere (not set yet)';
  switch (t.kind) {
    case 'person':
      return `person "${t.label || '(no name entered)'}"`;
    case 'team':
      return `department/team "${t.label || '(no name entered)'}"`;
    case 'message':
      return 'a recorded message';
    case 'voicemail':
      return 'voicemail';
    case 'external':
      return `outside number "${t.label || '(none entered)'}"`;
    case 'operator':
      return 'the operator';
    case 'call_queue':
      return t.flowId ? `call queue "${t.label}"` : 'a call queue (setup not finished)';
  }
};

function flowSummary(cf: WizardCallFlow | undefined, label: string): string[] {
  if (!cf) return [];
  const lines: string[] = [];
  lines.push(`${label}: ${cf.greeting ? `plays "${cf.greeting.slice(0, 60)}${cf.greeting.length > 60 ? '…' : ''}", then` : ''} ${
    cf.mode === 'menu'
      ? `offers a menu of ${(cf.options ?? []).length} option(s)`
      : cf.mode === 'voicemail'
        ? 'sends every call to voicemail'
        : `sends every call to ${targetSummary(cf.target)}`
  }`.trim());
  if (cf.mode === 'menu') {
    for (const o of cf.options ?? []) lines.push(`  · press ${o.key} for "${o.label || '(unnamed)'}" → ${targetSummary(o.target)}`);
  }
  return lines;
}

const DEFAULT_ANSWERS: AutoAttendantWizardAnswers = {
  languageId: 'en-US',
  timeZoneId: 'Eastern Standard Time',
  hoursType: 'standard',
  customHours: emptyWeekly(),
  businessFlow: { mode: 'menu', greeting: '', options: [] },
  afterHoursFlow: { mode: 'voicemail' },
  operator: undefined,
  holidaysEnabled: false,
  holidays: [],
};

/** An existing wizard-captured Call flows row, reopened for editing - see SiteWorkspace.tsx's onEditRow. */
export interface AutoAttendantWizardEditing {
  id: string;
  name: string;
  answers: AutoAttendantWizardAnswers;
  resourceAccountId: string | null;
}

export function AutoAttendantWizard({
  open,
  onOpenChange,
  base,
  tenantId,
  siteId,
  resourceAccountChoices,
  teamChoices,
  onCreated,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  tenantId: string;
  siteId: string;
  resourceAccountChoices: Choice[];
  teamChoices: TeamChoice[];
  onCreated: () => void;
  /** Editing an already-saved wizard capture instead of creating a new one - PATCHes the existing flow row and shows "Save changes" instead of "Create". Render with `key={editing.id}` so each row gets its own fresh state. */
  editing?: AutoAttendantWizardEditing;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [answers, setAnswers] = useState<AutoAttendantWizardAnswers>(editing?.answers ?? DEFAULT_ANSWERS);
  const [resourceAccountId, setResourceAccountId] = useState(editing?.resourceAccountId ?? '');
  const [raDialogOpen, setRaDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        ...(editing ? {} : { site_id: siteId, kind: 'auto_attendant' }),
        name,
        description: `Captured via the Auto Attendant wizard - ${flowSummary(answers.businessFlow, 'Business hours')[0] ?? ''}`,
        wizard_answers: answers,
        wizard_version: 1,
        resource_account_id: resourceAccountId || null,
      });
      return editing ? api(`${base}/flows/${editing.id}`, { method: 'PATCH', body }) : api(`${base}/flows`, { method: 'POST', body });
    },
    onSuccess: () => {
      onOpenChange(false);
      if (!editing) {
        setName('');
        setAnswers(DEFAULT_ANSWERS);
        setResourceAccountId('');
      }
      onCreated();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  const steps: WizardStep[] = [
    {
      key: 'basics',
      title: 'Basics',
      validate: () => (!name.trim() ? 'Give this phone menu a name.' : null),
      content: (
        <>
          <Field label="What do you want to call this phone menu?" required>
            <Input value={name} placeholder="Main Reception" onChange={(_, d) => setName(d.value)} />
          </Field>
          <Field label="What language should the automated voice speak?">
            <Dropdown
              value={AA_LANGUAGE_CHOICES.find((c) => c.value === answers.languageId)?.label ?? ''}
              selectedOptions={[answers.languageId]}
              onOptionSelect={(_, d) => setAnswers((a) => ({ ...a, languageId: d.optionValue ?? a.languageId }))}
            >
              {AA_LANGUAGE_CHOICES.map((c) => (
                <Option key={c.value} value={c.value}>
                  {c.label}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="What time zone is this for?">
            <Dropdown
              value={AA_TIME_ZONE_CHOICES.find((c) => c.value === answers.timeZoneId)?.label ?? ''}
              selectedOptions={[answers.timeZoneId]}
              onOptionSelect={(_, d) => setAnswers((a) => ({ ...a, timeZoneId: d.optionValue ?? a.timeZoneId }))}
            >
              {AA_TIME_ZONE_CHOICES.map((c) => (
                <Option key={c.value} value={c.value}>
                  {c.label}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </>
      ),
    },
    {
      key: 'hours',
      title: 'Hours',
      content: (
        <>
          <Text block>When is this normally open?</Text>
          <RadioGroup value={answers.hoursType} onChange={(_, d) => setAnswers((a) => ({ ...a, hoursType: d.value as typeof a.hoursType }))}>
            <Radio value="always" label="Open 24/7 - no separate after-hours message needed" />
            <Radio value="standard" label="Standard hours - Monday to Friday, 9am to 5pm" />
            <Radio value="custom" label="Custom hours - I'll set them myself" />
          </RadioGroup>
          {answers.hoursType === 'custom' && (
            <WeeklyHoursEditor
              value={answers.customHours ?? emptyWeekly()}
              onChange={(v) => setAnswers((a) => ({ ...a, customHours: v }))}
            />
          )}
        </>
      ),
    },
    {
      key: 'business',
      title: 'During business hours',
      content: (
        <CallFlowEditor
          value={answers.businessFlow}
          onChange={(v) => setAnswers((a) => ({ ...a, businessFlow: v }))}
          base={base}
          tenantId={tenantId}
          siteId={siteId}
          teamChoices={teamChoices}
          onFlowCreated={onCreated}
        />
      ),
    },
    ...(answers.hoursType !== 'always'
      ? [
          {
            key: 'after-hours',
            title: 'After hours',
            content: (
              <CallFlowEditor
                value={answers.afterHoursFlow ?? { mode: 'voicemail' }}
                onChange={(v) => setAnswers((a) => ({ ...a, afterHoursFlow: v }))}
                base={base}
                tenantId={tenantId}
                siteId={siteId}
                teamChoices={teamChoices}
                onFlowCreated={onCreated}
              />
            ),
          },
        ]
      : []),
    {
      key: 'operator',
      title: 'Operator',
      content: (
        <>
          <Text block>
            If a caller gets stuck or wants to skip the menu, who should they be able to reach? This is optional.
          </Text>
          <TargetPicker
            value={answers.operator}
            onChange={(t) => setAnswers((a) => ({ ...a, operator: t }))}
            kinds={['person', 'external']}
            allowNone
            tenantId={tenantId}
            siteId={siteId}
          />
        </>
      ),
    },
    {
      key: 'holidays',
      title: 'Holidays',
      content: (
        <>
          <Checkbox
            checked={answers.holidaysEnabled}
            label="Handle public holidays differently"
            onChange={(_, d) => setAnswers((a) => ({ ...a, holidaysEnabled: !!d.checked }))}
          />
          {answers.holidaysEnabled && (
            <div style={{ display: 'grid', gap: 10 }}>
              {(answers.holidays ?? []).map((h, i) => (
                <Card key={i} style={{ padding: 10, display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
                    <Field label="Holiday name">
                      <Input
                        value={h.name}
                        placeholder="Christmas Day"
                        onChange={(_, d) =>
                          setAnswers((a) => ({ ...a, holidays: (a.holidays ?? []).map((x, idx) => (idx === i ? { ...x, name: d.value } : x)) }))
                        }
                      />
                    </Field>
                    <Field label="From">
                      <Input
                        type="date"
                        value={h.dateRange.start}
                        onChange={(_, d) =>
                          setAnswers((a) => ({
                            ...a,
                            holidays: (a.holidays ?? []).map((x, idx) => (idx === i ? { ...x, dateRange: { ...x.dateRange, start: d.value } } : x)),
                          }))
                        }
                      />
                    </Field>
                    <Field label="To">
                      <Input
                        type="date"
                        value={h.dateRange.end}
                        onChange={(_, d) =>
                          setAnswers((a) => ({
                            ...a,
                            holidays: (a.holidays ?? []).map((x, idx) => (idx === i ? { ...x, dateRange: { ...x.dateRange, end: d.value } } : x)),
                          }))
                        }
                      />
                    </Field>
                    <Button
                      icon={<DeleteRegular />}
                      appearance="subtle"
                      aria-label="Remove holiday"
                      onClick={() => setAnswers((a) => ({ ...a, holidays: (a.holidays ?? []).filter((_, idx) => idx !== i) }))}
                    />
                  </div>
                  <CallFlowEditor
                    value={h.flow}
                    onChange={(v) => setAnswers((a) => ({ ...a, holidays: (a.holidays ?? []).map((x, idx) => (idx === i ? { ...x, flow: v } : x)) }))}
                    base={base}
                    tenantId={tenantId}
                    siteId={siteId}
                    teamChoices={teamChoices}
                    onFlowCreated={onCreated}
                  />
                </Card>
              ))}
              <Button
                size="small"
                icon={<AddRegular />}
                disabled={(answers.holidays ?? []).length >= 10}
                onClick={() =>
                  setAnswers((a) => ({
                    ...a,
                    holidays: [...(a.holidays ?? []), { name: '', dateRange: { start: '', end: '' }, flow: { mode: 'voicemail' } }],
                  }))
                }
              >
                Add holiday
              </Button>
            </div>
          )}
        </>
      ),
    },
    {
      key: 'review',
      title: 'Review',
      content: (
        <>
          <div style={{ display: 'grid', gap: 2 }}>
            {flowSummary(answers.businessFlow, 'Business hours').map((l, i) => (
              <Text key={i} size={200} block>
                {l}
              </Text>
            ))}
            {answers.hoursType !== 'always' &&
              flowSummary(answers.afterHoursFlow, 'After hours').map((l, i) => (
                <Text key={`ah-${i}`} size={200} block>
                  {l}
                </Text>
              ))}
            {answers.operator && (
              <Text size={200} block>
                Operator: {targetSummary(answers.operator)}
              </Text>
            )}
          </div>
          <Field label="Which phone number/identity will answer this? (optional - can be set later)">
            <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
              <Dropdown
                value={resourceAccountChoices.find((c) => c.value === resourceAccountId)?.label ?? '— not yet known —'}
                selectedOptions={resourceAccountId ? [resourceAccountId] : []}
                onOptionSelect={(_, d) => setResourceAccountId(d.optionValue ?? '')}
                style={{ minWidth: 220 }}
              >
                <Option value="">— not yet known —</Option>
                {resourceAccountChoices.map((c) => (
                  <Option key={c.value} value={c.value}>
                    {c.label}
                  </Option>
                ))}
              </Dropdown>
              <Button size="small" onClick={() => setRaDialogOpen(true)}>
                Set up a new resource account
              </Button>
            </div>
          </Field>
          <ResourceAccountCreateDialog
            open={raDialogOpen}
            onOpenChange={setRaDialogOpen}
            base={base}
            tenantId={tenantId}
            siteId={siteId}
            kind="auto_attendant"
            onCreated={(row) => {
              if (row) setResourceAccountId(row.id);
            }}
          />
        </>
      ),
    },
  ];

  return (
    <WizardShell
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        // Reset on Cancel too, not just on a successful save - the "New"
        // instance stays mounted the whole time (WizardTiles just toggles
        // `open`), so leftover text/answers from an abandoned attempt would
        // otherwise still be there next time this tile is opened. Not
        // needed in edit mode - that instance is remounted fresh (key={editing.id})
        // every time a different row is opened for editing.
        if (!o && !editing) {
          setError(null);
          setName('');
          setAnswers(DEFAULT_ANSWERS);
          setResourceAccountId('');
        }
      }}
      title={editing ? `Edit "${editing.name}"` : 'New Auto Attendant'}
      steps={steps}
      completing={save.isPending}
      completeLabel={editing ? 'Save changes' : 'Create'}
      error={error}
      onComplete={() => {
        setError(null);
        save.mutate();
      }}
    />
  );
}
