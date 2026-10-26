import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Dropdown, Field, Input, Option, Spinner, Text, tokens , makeStyles, shorthands } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { CALL_QUEUE_NO_AGENT_ACTIONS, CALL_QUEUE_NO_AGENT_APPLY_TO, CALL_QUEUE_OVERFLOW_ACTIONS, CALL_QUEUE_TIMEOUT_ACTIONS, type CallQueueActionSettings, type Paginated } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { GroupAutocomplete } from '../../components/GroupAutocomplete';
import { UpnAutocomplete } from '../../components/UpnAutocomplete';
import { PagedSection, type FieldDef, type Row } from '../../components/records';
import { DangerText } from '../../components/ui';

const useLocalStyles = makeStyles({
  minW180: { minWidth: '180px' },
  maxW640: { maxWidth: '640px' },
  gridGap16MinW560: { display: "grid", ...shorthands.gap('16px'), minWidth: '560px' },
  flexItemsCenterJustifySpacebetween: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  flexItemsCenterGap8Mt6: { display: "flex", ...shorthands.gap('8px'), alignItems: "center", marginTop: '6px' },
  minW220: { minWidth: '220px' },
  blockMt6Muted: { color: tokens.colorNeutralForeground3, display: "block", marginTop: '6px' },
  flexWrapItemsEndGap8Mt6: { display: "flex", ...shorthands.gap('8px'), flexWrap: "wrap", alignItems: "end", marginTop: '6px' },
  w120: { width: '120px' },
  minW320: { minWidth: '320px' },
  paletteMarigoldForeground2: { color: tokens.colorPaletteMarigoldForeground2 },
  gridGap4Mt6: { display: "grid", ...shorthands.gap('4px'), marginTop: '6px' },
});


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
  const ls = useLocalStyles();
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
  // PowerShell-only extras (not shown in Teams Admin Center): call priority and the prompt before a redirect.
  const [extras, setExtras] = useState({
    overflow: { priority: overflowInit?.priority, redirectPrompt: overflowInit?.redirectPrompt ?? '' },
    timeout: { priority: timeoutInit?.priority, redirectPrompt: timeoutInit?.redirectPrompt ?? '' },
    noAgent: { priority: noAgentInit?.priority, redirectPrompt: noAgentInit?.redirectPrompt ?? '' },
  });
  type ExtrasKey = keyof typeof extras;
  const extrasOf = (k: ExtrasKey, action: string): Pick<CallQueueActionSettings, 'priority' | 'redirectPrompt'> => ({
    ...(action === 'Forward' && extras[k].priority != null ? { priority: extras[k].priority } : {}),
    ...((action === 'Forward' || action === 'Voicemail') && extras[k].redirectPrompt.trim() ? { redirectPrompt: extras[k].redirectPrompt.trim() } : {}),
  });
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
            ...extrasOf('overflow', overflowAction),
          }
        : {};
      const timeout: CallQueueActionSettings = timeoutAction
        ? {
            action: timeoutAction as (typeof CALL_QUEUE_TIMEOUT_ACTIONS)[number],
            threshold: timeoutThreshold ? Number(timeoutThreshold) : undefined,
            target: timeoutTarget || undefined,
            ...extrasOf('timeout', timeoutAction),
          }
        : {};
      const no_agent_action: CallQueueActionSettings = noAgentAction
        ? { action: noAgentAction as (typeof CALL_QUEUE_NO_AGENT_ACTIONS)[number], target: noAgentTarget || undefined, ...extrasOf('noAgent', noAgentAction) }
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
        className={ls.minW180}
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

  /** Call priority (forward only) and the prompt the caller hears first (forward or personal voicemail). */
  const extrasFields = (k: ExtrasKey, action: string) =>
    action === 'Forward' || action === 'Voicemail' ? (
      <>
        {action === 'Forward' && (
          <Field label="Call priority" hint="When forwarding to another queue or auto attendant. PowerShell only - not shown in Teams Admin Center.">
            <Dropdown
              value={extras[k].priority != null ? String(extras[k].priority) : '— Teams default —'}
              selectedOptions={[extras[k].priority != null ? String(extras[k].priority) : 'unset']}
              onOptionSelect={(_, d) => setExtras((e) => ({ ...e, [k]: { ...e[k], priority: d.optionValue === 'unset' ? undefined : Number(d.optionValue) } }))}
              className={ls.minW180}
            >
              <Option value="unset">— Teams default —</Option>
              {['1', '2', '3', '4', '5'].map((p) => (
                <Option key={p} value={p}>
                  {p === '1' ? '1 (highest)' : p === '5' ? '5 (lowest)' : p}
                </Option>
              ))}
            </Dropdown>
          </Field>
        )}
        <Field label="Prompt before the redirect" hint="Text to speech the caller hears first. PowerShell only - not shown in Teams Admin Center.">
          <Input
            value={extras[k].redirectPrompt}
            onChange={(_, d) => setExtras((e) => ({ ...e, [k]: { ...e[k], redirectPrompt: d.value } }))}
            maxLength={1000}
            className={ls.minW320}
          />
        </Field>
      </>
    ) : null;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.maxW640}>
        <DialogBody>
          <DialogTitle>Call queue settings — {String(row.name)}</DialogTitle>
          <DialogContent>
            <div className={ls.gridGap16MinW560}>
              <div>
                <div className={ls.flexItemsCenterJustifySpacebetween}>
                  <Text weight="semibold">Agents</Text>
                  <Button size="small" appearance="subtle" disabled={agents.length >= 200} onClick={addAgent}>
                    Add agent
                  </Button>
                </div>
                {agents.map((a, i) => (
                  <div key={i} className={ls.flexItemsCenterGap8Mt6}>
                    <UpnAutocomplete tenantId={tenantId} value={a} onChange={(v) => updateAgent(i, v)} className={ls.minW220} />
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => removeAgent(i)} />
                  </div>
                ))}
                {agents.length === 0 && (
                  <Text size={200} className={ls.blockMt6Muted}>
                    No agents yet.
                  </Text>
                )}
              </div>

              <div>
                <Text weight="semibold">Overflow (queue full)</Text>
                <div className={ls.flexWrapItemsEndGap8Mt6}>
                  {actionDropdown('Action', overflowAction, (v) => { setOverflowAction(v); setOverflowTarget(''); }, CALL_QUEUE_OVERFLOW_ACTIONS)}
                  {overflowAction && (
                    <>
                      <Field label="Threshold (0-200 calls)">
                        <Input
                          type="number"
                          value={overflowThreshold}
                          onChange={(_, d) => setOverflowThreshold(d.value)}
                          className={ls.w120}
                        />
                      </Field>
                      {overflowAction === 'SharedVoicemail' && (
                        <Field label="Target (M365 group)">
                          <GroupAutocomplete tenantId={tenantId} value={overflowTarget} onChange={setOverflowTarget} className={ls.minW220} />
                        </Field>
                      )}
                      {overflowAction === 'Forward' && (
                        <Field label="Target">
                          <UpnAutocomplete tenantId={tenantId} value={overflowTarget} onChange={setOverflowTarget} className={ls.minW220} />
                        </Field>
                      )}
                      {overflowAction === 'Voicemail' && (
                        <Field label="Whose voicemail">
                          <UpnAutocomplete tenantId={tenantId} value={overflowTarget} onChange={setOverflowTarget} className={ls.minW220} />
                        </Field>
                      )}
                      {extrasFields('overflow', overflowAction)}
                    </>
                  )}
                </div>
              </div>

              <div>
                <Text weight="semibold">Timeout (waited too long)</Text>
                <div className={ls.flexWrapItemsEndGap8Mt6}>
                  {actionDropdown('Action', timeoutAction, (v) => { setTimeoutAction(v); setTimeoutTarget(''); }, CALL_QUEUE_TIMEOUT_ACTIONS)}
                  {timeoutAction && (
                    <>
                      <Field label="Threshold (0-2700 seconds)">
                        <Input
                          type="number"
                          value={timeoutThreshold}
                          onChange={(_, d) => setTimeoutThreshold(d.value)}
                          className={ls.w120}
                        />
                      </Field>
                      {timeoutAction === 'SharedVoicemail' && (
                        <Field label="Target (M365 group)">
                          <GroupAutocomplete tenantId={tenantId} value={timeoutTarget} onChange={setTimeoutTarget} className={ls.minW220} />
                        </Field>
                      )}
                      {timeoutAction === 'Forward' && (
                        <Field label="Target">
                          <UpnAutocomplete tenantId={tenantId} value={timeoutTarget} onChange={setTimeoutTarget} className={ls.minW220} />
                        </Field>
                      )}
                      {timeoutAction === 'Voicemail' && (
                        <Field label="Whose voicemail">
                          <UpnAutocomplete tenantId={tenantId} value={timeoutTarget} onChange={setTimeoutTarget} className={ls.minW220} />
                        </Field>
                      )}
                      {extrasFields('timeout', timeoutAction)}
                    </>
                  )}
                </div>
              </div>

              <div>
                <Text weight="semibold">No agents (zero opted in)</Text>
                <div className={ls.flexWrapItemsEndGap8Mt6}>
                  {actionDropdown('Action', noAgentAction, (v) => { setNoAgentAction(v); setNoAgentTarget(''); }, CALL_QUEUE_NO_AGENT_ACTIONS)}
                  {noAgentAction === 'SharedVoicemail' && (
                    <Field label="Target (M365 group)">
                      <GroupAutocomplete tenantId={tenantId} value={noAgentTarget} onChange={setNoAgentTarget} className={ls.minW220} />
                    </Field>
                  )}
                  {noAgentAction === 'Forward' && (
                    <Field label="Target">
                      <UpnAutocomplete tenantId={tenantId} value={noAgentTarget} onChange={setNoAgentTarget} className={ls.minW220} />
                    </Field>
                  )}
                  {noAgentAction === 'Voicemail' && (
                    <Field label="Whose voicemail">
                      <UpnAutocomplete tenantId={tenantId} value={noAgentTarget} onChange={setNoAgentTarget} className={ls.minW220} />
                    </Field>
                  )}
                  {noAgentAction && actionDropdown('Applies to', noAgentApplyTo, setNoAgentApplyTo, CALL_QUEUE_NO_AGENT_APPLY_TO)}
                  {extrasFields('noAgent', noAgentAction)}
                </div>
              </div>

              {(overflowAction === 'SharedVoicemail' || timeoutAction === 'SharedVoicemail' || noAgentAction === 'SharedVoicemail') && (
                <Text size={200} className={ls.paletteMarigoldForeground2}>
                  Shared Voicemail needs a Language ID set on this row - edit it from the table's Edit form.
                </Text>
              )}

              <div>
                <Text weight="semibold">Linked resource accounts (phone numbers)</Text>
                {raQ.isLoading ? (
                  <Spinner size="tiny" label="Loading…" />
                ) : raChoices.length === 0 ? (
                  <Text size={200} className={ls.blockMt6Muted}>
                    No Call Queue-kind resource accounts on this site yet - add one on the Resource accounts tab.
                  </Text>
                ) : (
                  <div className={ls.gridGap4Mt6}>
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
