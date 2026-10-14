import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Card, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Dropdown, Field, Input, Option, Spinner, Text, Textarea, tokens } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { AA_CALLABLE_ENTITY_KINDS, AA_DIRECTORY_SEARCH_METHODS, AA_DTMF_RESPONSES, AA_MENU_OPTION_ACTIONS, AA_SCHEDULE_TYPES, type AutoAttendantCallableEntity, type AutoAttendantCallFlow, type AutoAttendantHolidayCallFlow, type AutoAttendantMenuOption, type AutoAttendantSchedule, type AutoAttendantTimeRange, type Paginated } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { GroupAutocomplete } from '../../components/GroupAutocomplete';
import { UpnAutocomplete } from '../../components/UpnAutocomplete';
import { type Row } from '../../components/records';
import { DangerText, MutedText } from '../../components/ui';

/** A menu-option target (New-CsAutoAttendantCallableEntity) - same-site AA/CQ by name, a person by UPN, or a raw external number. */
function CallableEntityEditor({
  tenantId,
  value,
  onChange,
  aaChoices,
  cqChoices,
}: {
  tenantId: string;
  value: AutoAttendantCallableEntity | undefined;
  onChange: (v: AutoAttendantCallableEntity | undefined) => void;
  aaChoices: { id: string; name: string }[];
  cqChoices: { id: string; name: string }[];
}) {
  const kind = value?.kind ?? '';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
      <Field label="Target kind">
        <Dropdown
          value={kind || '— none —'}
          selectedOptions={[kind || 'none']}
          onOptionSelect={(_, d) => {
            const k = d.optionValue === 'none' ? '' : (d.optionValue ?? '');
            onChange(k ? { kind: k as (typeof AA_CALLABLE_ENTITY_KINDS)[number] } : undefined);
          }}
          style={{ minWidth: 170 }}
        >
          <Option value="none">— none —</Option>
          {AA_CALLABLE_ENTITY_KINDS.map((k) => (
            <Option key={k} value={k}>
              {k}
            </Option>
          ))}
        </Dropdown>
      </Field>
      {kind === 'auto_attendant' && (
        <Field label="Auto Attendant">
          <Dropdown
            value={aaChoices.find((a) => a.id === value?.buildId)?.name ?? '— select —'}
            selectedOptions={value?.buildId ? [value.buildId] : []}
            onOptionSelect={(_, d) => onChange({ kind: 'auto_attendant', buildId: d.optionValue })}
            style={{ minWidth: 220 }}
          >
            {aaChoices.map((a) => (
              <Option key={a.id} value={a.id}>
                {a.name}
              </Option>
            ))}
          </Dropdown>
        </Field>
      )}
      {kind === 'call_queue' && (
        <Field label="Call Queue">
          <Dropdown
            value={cqChoices.find((c) => c.id === value?.buildId)?.name ?? '— select —'}
            selectedOptions={value?.buildId ? [value.buildId] : []}
            onOptionSelect={(_, d) => onChange({ kind: 'call_queue', buildId: d.optionValue })}
            style={{ minWidth: 220 }}
          >
            {cqChoices.map((c) => (
              <Option key={c.id} value={c.id}>
                {c.name}
              </Option>
            ))}
          </Dropdown>
        </Field>
      )}
      {kind === 'user' && (
        <Field label="User">
          <UpnAutocomplete tenantId={tenantId} value={value?.upn ?? ''} onChange={(v) => onChange({ kind: 'user', upn: v })} style={{ minWidth: 220 }} />
        </Field>
      )}
      {kind === 'external' && (
        <Field label="External number">
          <Input
            value={value?.number ?? ''}
            onChange={(_, d) => onChange({ kind: 'external', number: d.value })}
            placeholder="tel:+1..."
            style={{ minWidth: 180 }}
          />
        </Field>
      )}
      {kind === 'shared_voicemail' && (
        <Field label="M365 group">
          <GroupAutocomplete
            tenantId={tenantId}
            value={value?.groupId ?? ''}
            onChange={(v) => onChange({ kind: 'shared_voicemail', groupId: v })}
            style={{ minWidth: 260 }}
          />
        </Field>
      )}
    </div>
  );
}

/** One New-CsAutoAttendantMenuOption row - DTMF digit, action, and (for TransferCallToTarget) its target. */
function MenuOptionRow({
  tenantId,
  value,
  onChange,
  onRemove,
  aaChoices,
  cqChoices,
}: {
  tenantId: string;
  value: AutoAttendantMenuOption;
  onChange: (v: AutoAttendantMenuOption) => void;
  onRemove: () => void;
  aaChoices: { id: string; name: string }[];
  cqChoices: { id: string; name: string }[];
}) {
  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 8, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
        <Field label="DTMF">
          <Dropdown
            value={value.dtmf}
            selectedOptions={[value.dtmf]}
            onOptionSelect={(_, d) => onChange({ ...value, dtmf: (d.optionValue ?? 'Automatic') as AutoAttendantMenuOption['dtmf'] })}
            style={{ minWidth: 110 }}
          >
            {AA_DTMF_RESPONSES.map((d) => (
              <Option key={d} value={d}>
                {d}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Action">
          <Dropdown
            value={value.action}
            selectedOptions={[value.action]}
            onOptionSelect={(_, d) => {
              const action = (d.optionValue ?? 'DisconnectCall') as AutoAttendantMenuOption['action'];
              onChange({
                ...value,
                action,
                target: action === 'TransferCallToTarget' ? value.target : undefined,
                prompt: action === 'Announcement' ? value.prompt : undefined,
              });
            }}
            style={{ minWidth: 190 }}
          >
            {AA_MENU_OPTION_ACTIONS.map((a) => (
              <Option key={a} value={a}>
                {a}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={onRemove} />
      </div>
      {value.action === 'TransferCallToTarget' && (
        <CallableEntityEditor
          tenantId={tenantId}
          value={value.target}
          onChange={(t) => onChange({ ...value, target: t })}
          aaChoices={aaChoices}
          cqChoices={cqChoices}
        />
      )}
      {value.action === 'Announcement' && (
        <Field label="Announcement (text-to-speech)" hint="Played to the caller, who then returns to this menu.">
          <Textarea
            value={value.prompt?.type === 'Text' ? (value.prompt.text ?? '') : ''}
            onChange={(_, d) => onChange({ ...value, prompt: d.value ? { type: 'Text', text: d.value } : undefined })}
            rows={2}
          />
        </Field>
      )}
      {value.action === 'TransferCallToOperator' && (
        <MutedText size={200}>
          Goes to this Auto Attendant&apos;s operator (set in the Operator section).
        </MutedText>
      )}
    </div>
  );
}

/** New-CsAutoAttendantCallFlow editor - greeting, dial-by-name, and the ordered DTMF menu. Reused for business hours, after hours, and each holiday. */
function CallFlowEditor({
  tenantId,
  value,
  onChange,
  aaChoices,
  cqChoices,
}: {
  tenantId: string;
  value: AutoAttendantCallFlow;
  onChange: (v: AutoAttendantCallFlow) => void;
  aaChoices: { id: string; name: string }[];
  cqChoices: { id: string; name: string }[];
}) {
  // Only a text-to-speech greeting/menu prompt is editable here - an AudioFile
  // prompt needs a file upload + Import-CsOnlineAudioFile flow not built yet
  // (planAutoAttendantRow silently drops one for the same reason, see its buildPrompt).
  const greetingText = value.greetings.find((g) => g.type === 'Text')?.text ?? '';
  const setGreetingText = (text: string) => onChange({ ...value, greetings: text ? [{ type: 'Text', text }] : [] });
  // New-CsAutoAttendantMenu -Prompts - what the menu itself reads out (e.g.
  // "For Sales press 1, for Support press 2") - distinct from the greeting
  // above, which only plays once when the call is answered.
  const menuPromptText = value.menu.prompts?.find((p) => p.type === 'Text')?.text ?? '';
  const setMenuPromptText = (text: string) =>
    onChange({ ...value, menu: { ...value.menu, prompts: text ? [{ type: 'Text', text }] : [] } });

  const addOption = () => {
    const used = new Set(value.menu.options.map((o) => o.dtmf));
    const next = AA_DTMF_RESPONSES.find((d) => !used.has(d)) ?? 'Automatic';
    onChange({ ...value, menu: { ...value.menu, options: [...value.menu.options, { dtmf: next, action: 'DisconnectCall' }] } });
  };
  const updateOption = (i: number, opt: AutoAttendantMenuOption) =>
    onChange({ ...value, menu: { ...value.menu, options: value.menu.options.map((o, idx) => (idx === i ? opt : o)) } });
  const removeOption = (i: number) =>
    onChange({ ...value, menu: { ...value.menu, options: value.menu.options.filter((_, idx) => idx !== i) } });

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <Field label="Greeting (text-to-speech)" hint="Played once when the call is answered.">
        <Textarea value={greetingText} onChange={(_, d) => setGreetingText(d.value)} rows={2} />
      </Field>
      <Field label="Menu prompt (text-to-speech)" hint='Read out after the greeting, e.g. "For Sales press 1, for Support press 2."'>
        <Textarea value={menuPromptText} onChange={(_, d) => setMenuPromptText(d.value)} rows={2} />
      </Field>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <Checkbox
          label="Enable dial-by-name directory"
          checked={!!value.menu.enableDialByName}
          onChange={(_, d) => onChange({ ...value, menu: { ...value.menu, enableDialByName: !!d.checked } })}
        />
        {value.menu.enableDialByName && (
          <Field label="Search by">
            <Dropdown
              value={value.menu.directorySearchMethod ?? 'ByName'}
              selectedOptions={[value.menu.directorySearchMethod ?? 'ByName']}
              onOptionSelect={(_, d) =>
                onChange({ ...value, menu: { ...value.menu, directorySearchMethod: d.optionValue as (typeof AA_DIRECTORY_SEARCH_METHODS)[number] } })
              }
              style={{ minWidth: 130 }}
            >
              {AA_DIRECTORY_SEARCH_METHODS.map((m) => (
                <Option key={m} value={m}>
                  {m}
                </Option>
              ))}
            </Dropdown>
          </Field>
        )}
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text weight="semibold" size={200}>
            Menu options
          </Text>
          <Button size="small" appearance="subtle" disabled={value.menu.options.length >= 12} onClick={addOption}>
            Add option
          </Button>
        </div>
        <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
          {value.menu.options.map((o, i) => (
            <MenuOptionRow
              key={i}
              tenantId={tenantId}
              value={o}
              onChange={(v) => updateOption(i, v)}
              onRemove={() => removeOption(i)}
              aaChoices={aaChoices}
              cqChoices={cqChoices}
            />
          ))}
          {value.menu.options.length === 0 && (
            <MutedText size={200}>
              No menu options yet - callers hear the greeting then silence.
            </MutedText>
          )}
        </div>
      </div>
    </div>
  );
}

const WEEKDAYS = [
  { key: 'monday', label: 'Mon' },
  { key: 'tuesday', label: 'Tue' },
  { key: 'wednesday', label: 'Wed' },
  { key: 'thursday', label: 'Thu' },
  { key: 'friday', label: 'Fri' },
  { key: 'saturday', label: 'Sat' },
  { key: 'sunday', label: 'Sun' },
] as const;

function emptyWeekly(): NonNullable<AutoAttendantSchedule['weekly']> {
  return { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
}

/** New-CsOnlineSchedule editor - a weekly hours grid (with -Complement) or a fixed date-range list. Reused for the after-hours schedule and each holiday's own dates. */
function ScheduleEditor({ value, onChange }: { value: AutoAttendantSchedule; onChange: (v: AutoAttendantSchedule) => void }) {
  const setType = (type: (typeof AA_SCHEDULE_TYPES)[number]) =>
    onChange(type === 'weekly' ? { type: 'weekly', weekly: value.weekly ?? emptyWeekly() } : { type: 'fixed', fixed: value.fixed ?? { ranges: [] } });

  const setDayRanges = (day: (typeof WEEKDAYS)[number]['key'], ranges: AutoAttendantTimeRange[]) => {
    if (!value.weekly) return;
    onChange({ ...value, weekly: { ...value.weekly, [day]: ranges } });
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <Field label="Type">
        <Dropdown value={value.type} selectedOptions={[value.type]} onOptionSelect={(_, d) => setType((d.optionValue ?? 'weekly') as (typeof AA_SCHEDULE_TYPES)[number])} style={{ minWidth: 130 }}>
          {AA_SCHEDULE_TYPES.map((t) => (
            <Option key={t} value={t}>
              {t}
            </Option>
          ))}
        </Dropdown>
      </Field>
      {value.type === 'weekly' && value.weekly && (
        <>
          <div style={{ display: 'grid', gap: 6 }}>
            {WEEKDAYS.map(({ key, label }) => {
              const ranges = value.weekly![key] ?? [];
              return (
                <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Text size={200} style={{ width: 32 }}>
                    {label}
                  </Text>
                  {ranges.map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <Input
                        value={r.start}
                        onChange={(_, d) => setDayRanges(key, ranges.map((rr, idx) => (idx === i ? { ...rr, start: d.value } : rr)))}
                        placeholder="08:00"
                        style={{ width: 76 }}
                      />
                      <Text size={200}>–</Text>
                      <Input
                        value={r.end}
                        onChange={(_, d) => setDayRanges(key, ranges.map((rr, idx) => (idx === i ? { ...rr, end: d.value } : rr)))}
                        placeholder="16:00"
                        style={{ width: 76 }}
                      />
                      <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => setDayRanges(key, ranges.filter((_, idx) => idx !== i))} />
                    </div>
                  ))}
                  <Button size="small" appearance="subtle" disabled={ranges.length >= 4} onClick={() => setDayRanges(key, [...ranges, { start: '08:00', end: '17:00' }])}>
                    + hours
                  </Button>
                </div>
              );
            })}
          </div>
          <Checkbox
            label="Complement (fires outside these hours, not during them - this is what makes it an after-hours schedule)"
            checked={!!value.weekly.complement}
            onChange={(_, d) => onChange({ ...value, weekly: { ...value.weekly!, complement: !!d.checked } })}
          />
        </>
      )}
      {value.type === 'fixed' && value.fixed && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text weight="semibold" size={200}>
              Date ranges
            </Text>
            <Button
              size="small"
              appearance="subtle"
              disabled={value.fixed.ranges.length >= 10}
              onClick={() => onChange({ ...value, fixed: { ranges: [...value.fixed!.ranges, { start: '', end: '' }] } })}
            >
              Add range
            </Button>
          </div>
          {value.fixed.ranges.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <Input
                value={r.start}
                onChange={(_, d) => onChange({ ...value, fixed: { ranges: value.fixed!.ranges.map((rr, idx) => (idx === i ? { ...rr, start: d.value } : rr)) } })}
                placeholder="2026-12-25T00:00:00"
                style={{ minWidth: 190 }}
              />
              <Text size={200}>–</Text>
              <Input
                value={r.end}
                onChange={(_, d) => onChange({ ...value, fixed: { ranges: value.fixed!.ranges.map((rr, idx) => (idx === i ? { ...rr, end: d.value } : rr)) } })}
                placeholder="2026-12-26T00:00:00"
                style={{ minWidth: 190 }}
              />
              <Button
                size="small"
                appearance="subtle"
                icon={<DeleteRegular />}
                onClick={() => onChange({ ...value, fixed: { ranges: value.fixed!.ranges.filter((_, idx) => idx !== i) } })}
              />
            </div>
          ))}
          {value.fixed.ranges.length === 0 && (
            <Text size={200} style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: 6 }}>
              No date ranges yet.
            </Text>
          )}
        </div>
      )}
    </div>
  );
}

export function AutoAttendantSettingsDialog({
  tenantId,
  base,
  siteId,
  row,
  onClose,
  onSaved,
}: {
  tenantId: string;
  base: string;
  siteId: string;
  row: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [operator, setOperator] = useState<AutoAttendantCallableEntity | undefined>((row.operator as AutoAttendantCallableEntity | null) ?? undefined);
  const [defaultCallFlow, setDefaultCallFlow] = useState<AutoAttendantCallFlow>(
    (row.default_call_flow as AutoAttendantCallFlow | null) ?? { greetings: [], menu: { options: [] } },
  );
  const initialAfterHours = row.after_hours_call_flow as AutoAttendantCallFlow | null;
  const [afterHoursEnabled, setAfterHoursEnabled] = useState(!!initialAfterHours);
  const [afterHoursCallFlow, setAfterHoursCallFlow] = useState<AutoAttendantCallFlow>(initialAfterHours ?? { greetings: [], menu: { options: [] } });
  const [schedule, setSchedule] = useState<AutoAttendantSchedule>((row.schedule as AutoAttendantSchedule | null) ?? { type: 'weekly', weekly: emptyWeekly() });
  const [holidays, setHolidays] = useState<AutoAttendantHolidayCallFlow[]>(
    Array.isArray(row.holiday_call_flows) ? (row.holiday_call_flows as AutoAttendantHolidayCallFlow[]).slice() : [],
  );
  const [resourceAccounts, setResourceAccounts] = useState<string[]>(
    Array.isArray(row.resource_accounts) ? (row.resource_accounts as string[]).slice() : [],
  );
  const [err, setErr] = useState<string | null>(null);

  // Same-site AA/CQ choices for menu-option/-Operator targets - this row excluded
  // from its own AA list (an AA can't transfer to itself).
  const aaQ = useQuery({
    queryKey: ['auto-attendants', tenantId, siteId, 'for-target-picker'],
    queryFn: () => api<Paginated<Row>>(`${base}/auto-attendants?siteId=${siteId}&limit=500`),
  });
  const cqQ = useQuery({
    queryKey: ['call-queues', tenantId, siteId, 'for-target-picker'],
    queryFn: () => api<Paginated<Row>>(`${base}/call-queues?siteId=${siteId}&limit=500`),
  });
  const aaChoices = (aaQ.data?.items ?? []).filter((r) => r.id !== row.id).map((r) => ({ id: String(r.id), name: String(r.name) }));
  const cqChoices = (cqQ.data?.items ?? []).map((r) => ({ id: String(r.id), name: String(r.name) }));

  // Only Auto Attendant-kind resource accounts on this site can be linked -
  // same pattern as CallQueueSettingsDialog's own raQ/raChoices. An AA can
  // have several resource accounts, or none yet, exactly like a Call Queue.
  const raQ = useQuery({
    queryKey: ['resource-accounts', tenantId, siteId, 'for-auto-attendant'],
    queryFn: () => api<Paginated<Row>>(`${base}/resource-accounts?siteId=${siteId}&limit=500`),
  });
  const raChoices = (raQ.data?.items ?? []).filter((r) => r.kind === 'auto_attendant');
  const toggleRa = (id: string) =>
    setResourceAccounts((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const save = useMutation({
    mutationFn: () =>
      api(`${base}/auto-attendants/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          operator: operator ?? null,
          default_call_flow: defaultCallFlow,
          after_hours_call_flow: afterHoursEnabled ? afterHoursCallFlow : null,
          schedule: afterHoursEnabled ? schedule : null,
          holiday_call_flows: holidays,
          resource_accounts: resourceAccounts,
        }),
      }),
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const addHoliday = () =>
    setHolidays((h) => [
      ...h,
      { name: `Holiday ${h.length + 1}`, callFlow: { greetings: [], menu: { options: [] } }, schedule: { type: 'fixed', fixed: { ranges: [] } } },
    ]);
  const updateHoliday = (i: number, patch: Partial<AutoAttendantHolidayCallFlow>) => setHolidays((h) => h.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeHoliday = (i: number) => setHolidays((h) => h.filter((_, idx) => idx !== i));

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 780 }}>
        <DialogBody>
          <DialogTitle>Auto Attendant call flow — {String(row.name)}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'grid', gap: 20, minWidth: 700, maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>
              <div>
                <Text weight="semibold">Operator (optional)</Text>
                <div style={{ marginTop: 6 }}>
                  <CallableEntityEditor tenantId={tenantId} value={operator} onChange={setOperator} aaChoices={aaChoices} cqChoices={cqChoices} />
                </div>
              </div>

              <div>
                <Text weight="semibold">Business hours</Text>
                <div style={{ marginTop: 6 }}>
                  <CallFlowEditor tenantId={tenantId} value={defaultCallFlow} onChange={setDefaultCallFlow} aaChoices={aaChoices} cqChoices={cqChoices} />
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text weight="semibold">After hours</Text>
                  <Checkbox label="Has its own after-hours call flow" checked={afterHoursEnabled} onChange={(_, d) => setAfterHoursEnabled(!!d.checked)} />
                </div>
                {afterHoursEnabled && (
                  <div style={{ display: 'grid', gap: 12, marginTop: 6 }}>
                    <CallFlowEditor tenantId={tenantId} value={afterHoursCallFlow} onChange={setAfterHoursCallFlow} aaChoices={aaChoices} cqChoices={cqChoices} />
                    <div>
                      <Text weight="semibold" size={200}>
                        Schedule (when this fires)
                      </Text>
                      <ScheduleEditor value={schedule} onChange={setSchedule} />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text weight="semibold">Holidays</Text>
                  <Button size="small" appearance="subtle" disabled={holidays.length >= 10} onClick={addHoliday}>
                    Add holiday
                  </Button>
                </div>
                <div style={{ display: 'grid', gap: 12, marginTop: 6 }}>
                  {holidays.map((h, i) => (
                    <Card key={i} style={{ padding: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: 8 }}>
                        <Field label="Name" style={{ flex: 1 }}>
                          <Input value={h.name} onChange={(_, d) => updateHoliday(i, { name: d.value })} />
                        </Field>
                        <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => removeHoliday(i)} />
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <CallFlowEditor tenantId={tenantId} value={h.callFlow} onChange={(cf) => updateHoliday(i, { callFlow: cf })} aaChoices={aaChoices} cqChoices={cqChoices} />
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <Text weight="semibold" size={200}>
                          Dates
                        </Text>
                        <ScheduleEditor value={h.schedule} onChange={(sc) => updateHoliday(i, { schedule: sc })} />
                      </div>
                    </Card>
                  ))}
                  {holidays.length === 0 && (
                    <MutedText size={200}>
                      No holiday call flows yet.
                    </MutedText>
                  )}
                </div>
              </div>

              <div>
                <Text weight="semibold">Linked resource accounts (phone numbers)</Text>
                {raQ.isLoading ? (
                  <Spinner size="tiny" label="Loading…" />
                ) : raChoices.length === 0 ? (
                  <Text size={200} style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: 6 }}>
                    No Auto Attendant-kind resource accounts on this site yet - add one on the Resource accounts tab.
                  </Text>
                ) : (
                  <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                    {raChoices.map((r) => (
                      <Checkbox
                        key={String(r.id)}
                        label={`${r.display_name ?? r.upn}${r.upn ? ` (${r.upn})` : ''}`}
                        checked={resourceAccounts.includes(String(r.id))}
                        onChange={() => toggleRa(String(r.id))}
                      />
                    ))}
                  </div>
                )}
              </div>

              {err && (
                <DangerText block>
                  {err}
                </DangerText>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onClose}>
                Cancel
              </Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
