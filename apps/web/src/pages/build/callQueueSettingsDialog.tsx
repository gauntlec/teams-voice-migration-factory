import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Dropdown, Field, Input, Option, Spinner, Text, tokens } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { CALL_QUEUE_NO_AGENT_ACTIONS, CALL_QUEUE_NO_AGENT_APPLY_TO, CALL_QUEUE_OVERFLOW_ACTIONS, CALL_QUEUE_TIMEOUT_ACTIONS, type CallQueueActionSettings, type Paginated } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { GroupAutocomplete } from '../../components/GroupAutocomplete';
import { UpnAutocomplete } from '../../components/UpnAutocomplete';
import { PagedSection, type FieldDef, type Row } from '../../components/records';
import { DangerText } from '../../components/ui';

/**
 * Agents/overflow/timeout/linked resource accounts for one build_call_queues
 * row - same "compound JSON doesn't fit the generic FieldDef grid" reasoning
 * as CallingSettingsDialog above; the scalar fields (name, routing method,
 * agent alert time, ...) go through the normal PagedSection edit dialog.
 */
export function CallQueueSettingsDialog({
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
  const overflowInit = (row.overflow as CallQueueActionSettings | null) ?? null;
  const timeoutInit = (row.timeout as CallQueueActionSettings | null) ?? null;
  const noAgentInit = (row.no_agent_action as CallQueueActionSettings | null) ?? null;

  const [agents, setAgents] = useState<string[]>(Array.isArray(row.agents) ? (row.agents as string[]).slice() : []);
  const [overflowAction, setOverflowAction] = useState(overflowInit?.action ?? '');
  const [overflowThreshold, setOverflowThreshold] = useState(
    overflowInit?.threshold != null ? String(overflowInit.threshold) : '',
  );
  const [overflowTarget, setOverflowTarget] = useState(overflowInit?.target ?? '');
  const [timeoutAction, setTimeoutAction] = useState(timeoutInit?.action ?? '');
  const [timeoutThreshold, setTimeoutThreshold] = useState(
    timeoutInit?.threshold != null ? String(timeoutInit.threshold) : '',
  );
  const [timeoutTarget, setTimeoutTarget] = useState(timeoutInit?.target ?? '');
  const [noAgentAction, setNoAgentAction] = useState(noAgentInit?.action ?? '');
  const [noAgentTarget, setNoAgentTarget] = useState(noAgentInit?.target ?? '');
  const [noAgentApplyTo, setNoAgentApplyTo] = useState((row.no_agent_apply_to as string) ?? '');
  const [resourceAccounts, setResourceAccounts] = useState<string[]>(
    Array.isArray(row.resource_accounts) ? (row.resource_accounts as string[]).slice() : [],
  );
  const [err, setErr] = useState<string | null>(null);

  // Only Call Queue-kind resource accounts on this site can be linked -
  // reuses the Resource accounts tab's own list rather than a new endpoint.
  const raQ = useQuery({
    queryKey: ['resource-accounts', tenantId, siteId, 'for-call-queue'],
    queryFn: () => api<Paginated<Row>>(`${base}/resource-accounts?siteId=${siteId}&limit=500`),
  });
  const raChoices = (raQ.data?.items ?? []).filter((r) => r.kind === 'call_queue');

  const save = useMutation({
    mutationFn: () => {
      const overflow: CallQueueActionSettings = overflowAction
        ? {
            action: overflowAction as (typeof CALL_QUEUE_OVERFLOW_ACTIONS)[number],
            threshold: overflowThreshold ? Number(overflowThreshold) : undefined,
            target: overflowTarget || undefined,
          }
        : {};
      const timeout: CallQueueActionSettings = timeoutAction
        ? {
            action: timeoutAction as (typeof CALL_QUEUE_TIMEOUT_ACTIONS)[number],
            threshold: timeoutThreshold ? Number(timeoutThreshold) : undefined,
            target: timeoutTarget || undefined,
          }
        : {};
      const no_agent_action: CallQueueActionSettings = noAgentAction
        ? { action: noAgentAction as (typeof CALL_QUEUE_NO_AGENT_ACTIONS)[number], target: noAgentTarget || undefined }
        : {};
      return api(`${base}/call-queues/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          agents,
          overflow,
          timeout,
          no_agent_action,
          no_agent_apply_to: noAgentApplyTo || null,
          resource_accounts: resourceAccounts,
        }),
      });
    },
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const addAgent = () => setAgents((a) => [...a, '']);
  const updateAgent = (i: number, v: string) => setAgents((a) => a.map((x, idx) => (idx === i ? v : x)));
  const removeAgent = (i: number) => setAgents((a) => a.filter((_, idx) => idx !== i));
  const toggleRa = (id: string) =>
    setResourceAccounts((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const actionDropdown = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    options: readonly string[],
  ) => (
    <Field label={label}>
      <Dropdown
        value={value || '— not set —'}
        selectedOptions={[value || 'unset']}
        onOptionSelect={(_, d) => onChange(d.optionValue === 'unset' ? '' : (d.optionValue ?? ''))}
        style={{ minWidth: 180 }}
      >
        <Option value="unset">— not set —</Option>
        {options.map((o) => (
          <Option key={o} value={o}>
            {o}
          </Option>
        ))}
      </Dropdown>
    </Field>
  );

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>Call queue settings — {String(row.name)}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'grid', gap: 16, minWidth: 560 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text weight="semibold">Agents</Text>
                  <Button size="small" appearance="subtle" disabled={agents.length >= 200} onClick={addAgent}>
                    Add agent
                  </Button>
                </div>
                {agents.map((a, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <UpnAutocomplete tenantId={tenantId} value={a} onChange={(v) => updateAgent(i, v)} style={{ minWidth: 220 }} />
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => removeAgent(i)} />
                  </div>
                ))}
                {agents.length === 0 && (
                  <Text size={200} style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: 6 }}>
                    No agents yet.
                  </Text>
                )}
              </div>

              <div>
                <Text weight="semibold">Overflow (queue full)</Text>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 6 }}>
                  {actionDropdown('Action', overflowAction, (v) => { setOverflowAction(v); setOverflowTarget(''); }, CALL_QUEUE_OVERFLOW_ACTIONS)}
                  {overflowAction && (
                    <>
                      <Field label="Threshold (0-200 calls)">
                        <Input
                          type="number"
                          value={overflowThreshold}
                          onChange={(_, d) => setOverflowThreshold(d.value)}
                          style={{ width: 120 }}
                        />
                      </Field>
                      {overflowAction === 'SharedVoicemail' && (
                        <Field label="Target (M365 group)">
                          <GroupAutocomplete tenantId={tenantId} value={overflowTarget} onChange={setOverflowTarget} style={{ minWidth: 220 }} />
                        </Field>
                      )}
                      {overflowAction === 'Forward' && (
                        <Field label="Target">
                          <UpnAutocomplete tenantId={tenantId} value={overflowTarget} onChange={setOverflowTarget} style={{ minWidth: 220 }} />
                        </Field>
                      )}
                      {overflowAction === 'Voicemail' && (
                        <Field label="Whose voicemail">
                          <UpnAutocomplete tenantId={tenantId} value={overflowTarget} onChange={setOverflowTarget} style={{ minWidth: 220 }} />
                        </Field>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div>
                <Text weight="semibold">Timeout (waited too long)</Text>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 6 }}>
                  {actionDropdown('Action', timeoutAction, (v) => { setTimeoutAction(v); setTimeoutTarget(''); }, CALL_QUEUE_TIMEOUT_ACTIONS)}
                  {timeoutAction && (
                    <>
                      <Field label="Threshold (0-2700 seconds)">
                        <Input
                          type="number"
                          value={timeoutThreshold}
                          onChange={(_, d) => setTimeoutThreshold(d.value)}
                          style={{ width: 120 }}
                        />
                      </Field>
                      {timeoutAction === 'SharedVoicemail' && (
                        <Field label="Target (M365 group)">
                          <GroupAutocomplete tenantId={tenantId} value={timeoutTarget} onChange={setTimeoutTarget} style={{ minWidth: 220 }} />
                        </Field>
                      )}
                      {timeoutAction === 'Forward' && (
                        <Field label="Target">
                          <UpnAutocomplete tenantId={tenantId} value={timeoutTarget} onChange={setTimeoutTarget} style={{ minWidth: 220 }} />
                        </Field>
                      )}
                      {timeoutAction === 'Voicemail' && (
                        <Field label="Whose voicemail">
                          <UpnAutocomplete tenantId={tenantId} value={timeoutTarget} onChange={setTimeoutTarget} style={{ minWidth: 220 }} />
                        </Field>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div>
                <Text weight="semibold">No agents (zero opted in)</Text>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 6 }}>
                  {actionDropdown('Action', noAgentAction, (v) => { setNoAgentAction(v); setNoAgentTarget(''); }, CALL_QUEUE_NO_AGENT_ACTIONS)}
                  {noAgentAction === 'SharedVoicemail' && (
                    <Field label="Target (M365 group)">
                      <GroupAutocomplete tenantId={tenantId} value={noAgentTarget} onChange={setNoAgentTarget} style={{ minWidth: 220 }} />
                    </Field>
                  )}
                  {noAgentAction === 'Forward' && (
                    <Field label="Target">
                      <UpnAutocomplete tenantId={tenantId} value={noAgentTarget} onChange={setNoAgentTarget} style={{ minWidth: 220 }} />
                    </Field>
                  )}
                  {noAgentAction === 'Voicemail' && (
                    <Field label="Whose voicemail">
                      <UpnAutocomplete tenantId={tenantId} value={noAgentTarget} onChange={setNoAgentTarget} style={{ minWidth: 220 }} />
                    </Field>
                  )}
                  {noAgentAction && actionDropdown('Applies to', noAgentApplyTo, setNoAgentApplyTo, CALL_QUEUE_NO_AGENT_APPLY_TO)}
                </div>
              </div>

              {(overflowAction === 'SharedVoicemail' || timeoutAction === 'SharedVoicemail' || noAgentAction === 'SharedVoicemail') && (
                <Text size={200} style={{ color: tokens.colorPaletteMarigoldForeground2 }}>
                  Shared Voicemail needs a Language ID set on this row - edit it from the table's Edit form.
                </Text>
              )}

              <div>
                <Text weight="semibold">Linked resource accounts (phone numbers)</Text>
                {raQ.isLoading ? (
                  <Spinner size="tiny" label="Loading…" />
                ) : raChoices.length === 0 ? (
                  <Text size={200} style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: 6 }}>
                    No Call Queue-kind resource accounts on this site yet - add one on the Resource accounts tab.
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
