import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Dropdown, Field, Option, Spinner, Text, tokens , makeStyles, shorthands } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { BUSY_ON_BUSY_OPTIONS, CALL_FORWARDING_TYPES, CALL_GROUP_ORDERS, CALL_TARGET_TYPES, type CallDelegate, type CallForwardingSettings, type PickupGroupSettings } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { UpnAutocomplete } from '../../components/UpnAutocomplete';
import { type Choice, type Row } from '../../components/records';
import { DangerText } from '../../components/ui';

const useLocalStyles = makeStyles({
  mb12: { marginBottom: '12px' },
  gridGap8: { display: "grid", ...shorthands.gap('8px') },
  flexItemsCenterGap8: { display: "flex", alignItems: "center", ...shorthands.gap('8px') },
  w160: { width: '160px' },
  minW260Flex1: { minWidth: '260px', flex: 1 },
  minW140: { minWidth: '140px' },
  maxW640: { maxWidth: '640px' },
  gridGap16MinW560: { display: "grid", ...shorthands.gap('16px'), minWidth: '560px' },
  flexWrapItemsEndGap8Mt6: { display: "flex", ...shorthands.gap('8px'), flexWrap: "wrap", alignItems: "end", marginTop: '6px' },
  minW220: { minWidth: '220px' },
  maxW260: { maxWidth: '260px' },
  flexItemsCenterJustifySpacebetween: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  mt6: { marginTop: '6px' },
  maxW200: { maxWidth: '200px' },
  flexItemsCenterGap8Mt6: { display: "flex", ...shorthands.gap('8px'), alignItems: "center", marginTop: '6px' },
  blockMt6Muted: { color: tokens.colorNeutralForeground3, display: "block", marginTop: '6px' },
  flexWrapItemsCenterGap8Mt6: { display: "flex", ...shorthands.gap('8px'), flexWrap: "wrap", alignItems: "center", marginTop: '6px' },
});


interface CallingPolicyMapRow {
  discoveryCallingPolicyId: string;
  name: string;
  inUse: boolean;
  tenantPolicyId: string | null;
  tenantPolicyName: string | null;
}

/**
 * Which real tenant Voice Routing Policy each Data Collection generic
 * calling policy ("International", "Standard", …) means for THIS site -
 * OnlineVoiceRoutingPolicy is the Teams concept that actually governs
 * local/national/international dialing permission (not TeamsCallingPolicy,
 * which is call features like forwarding/park/busy-on-busy). See
 * BuildService.assertCallingPoliciesMapped, which blocks Populate until
 * every policy actually in use here has a row.
 */
export function CallingPolicyMapDialog({
  open,
  onOpenChange,
  base,
  siteId,
  callingPolicyChoices,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  siteId: string;
  callingPolicyChoices: Choice[];
}) {
  const ls = useLocalStyles();
  const qc = useQueryClient();
  const rowsQ = useQuery({
    queryKey: ['calling-policy-map', base, siteId],
    enabled: open,
    queryFn: () => api<CallingPolicyMapRow[]>(`${base}/calling-policy-map?siteId=${siteId}`),
  });
  const setMut = useMutation({
    mutationFn: (body: { discovery_calling_policy_id: string; tenant_policy_id: string }) =>
      api(`${base}/calling-policy-map`, { method: 'POST', body: JSON.stringify({ site_id: siteId, ...body }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calling-policy-map', base, siteId] }),
  });

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Calling policy map</DialogTitle>
          <DialogContent>
            <Text size={200} block className={ls.mb12}>
              Which real tenant Voice Routing Policy each Data Collection calling policy means for this site -
              that's the Teams policy that actually governs local/national/international dialing, not the Teams
              Calling Policy. "International" here might be a different real policy on a US site than on a Belgium
              one. A policy marked "in use, unmapped" must be mapped before Populate from Data Collection can run.
            </Text>
            {rowsQ.isLoading ? (
              <Spinner size="tiny" label="Loading…" />
            ) : (rowsQ.data ?? []).length === 0 ? (
              <Text size={200}>No calling policies defined in Data Collection yet.</Text>
            ) : (
              <div className={ls.gridGap8}>
                {(rowsQ.data ?? []).map((r) => (
                  <div key={r.discoveryCallingPolicyId} className={ls.flexItemsCenterGap8}>
                    <Text className={ls.w160}>{r.name}</Text>
                    {r.inUse && !r.tenantPolicyId && (
                      <Badge appearance="tint" color="danger" size="small">
                        in use, unmapped
                      </Badge>
                    )}
                    <Dropdown
                      className={ls.minW260Flex1}
                      placeholder="Select the real tenant policy…"
                      value={callingPolicyChoices.find((c) => c.value === r.tenantPolicyId)?.label ?? ''}
                      selectedOptions={r.tenantPolicyId ? [r.tenantPolicyId] : []}
                      onOptionSelect={(_, d) => {
                        if (d.optionValue) {
                          setMut.mutate({ discovery_calling_policy_id: r.discoveryCallingPolicyId, tenant_policy_id: d.optionValue });
                        }
                      }}
                    >
                      {callingPolicyChoices.map((c) => (
                        <Option key={c.value} value={c.value} text={c.label}>
                          {c.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </div>
                ))}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** unset = no cmdlet planned at all; off = explicitly disabled (Set-...-Enabled $false); on = configured. */
type TriState = 'unset' | 'off' | 'on';

const UNANSWERED_DELAYS = [5, 10, 15, 20, 30, 40, 50, 60];

export function CallingSettingsDialog({
  tenantId,
  endpoint,
  row,
  onClose,
  onSaved,
}: {
  tenantId: string;
  endpoint: string;
  row: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ls = useLocalStyles();
  const cf = (row.call_forwarding as CallForwardingSettings | null) ?? null;
  const pg = (row.pickup_group as PickupGroupSettings | null) ?? null;

  const [fwdMode, setFwdMode] = useState<TriState>(cf?.forwarding ? (cf.forwarding.enabled ? 'on' : 'off') : 'unset');
  const [fwdType, setFwdType] = useState<string>(cf?.forwarding?.type ?? 'Immediate');
  const [fwdTargetType, setFwdTargetType] = useState<string>(cf?.forwarding?.targetType ?? 'Voicemail');
  const [fwdTarget, setFwdTarget] = useState(cf?.forwarding?.target ?? '');

  const [unaMode, setUnaMode] = useState<TriState>(cf?.unanswered ? (cf.unanswered.enabled ? 'on' : 'off') : 'unset');
  const [unaDelay, setUnaDelay] = useState<number>(cf?.unanswered?.delaySeconds ?? 20);
  const [unaTargetType, setUnaTargetType] = useState<string>(cf?.unanswered?.targetType ?? 'Voicemail');
  const [unaTarget, setUnaTarget] = useState(cf?.unanswered?.target ?? '');

  const [busyOnBusy, setBusyOnBusy] = useState<string>(cf?.busyOnBusy ?? '');

  const [pgOrder, setPgOrder] = useState<string>(pg?.order ?? 'Simultaneous');
  const [pgTargets, setPgTargets] = useState<string[]>(pg?.targets ? [...pg.targets] : []);

  const [delegates, setDelegates] = useState<CallDelegate[]>(
    Array.isArray(row.delegates) ? (row.delegates as CallDelegate[]).slice() : [],
  );

  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const call_forwarding: CallForwardingSettings = {};
      if (fwdMode !== 'unset') {
        call_forwarding.forwarding =
          fwdMode === 'on'
            ? {
                enabled: true,
                type: fwdType as (typeof CALL_FORWARDING_TYPES)[number],
                targetType: fwdTargetType as (typeof CALL_TARGET_TYPES)[number],
                target: fwdTargetType === 'SingleTarget' ? fwdTarget : undefined,
              }
            : { enabled: false };
      }
      if (unaMode !== 'unset') {
        call_forwarding.unanswered =
          unaMode === 'on'
            ? {
                enabled: true,
                delaySeconds: unaDelay,
                targetType: unaTargetType as (typeof CALL_TARGET_TYPES)[number],
                target: unaTargetType === 'SingleTarget' ? unaTarget : undefined,
              }
            : { enabled: false };
      }
      if (busyOnBusy) call_forwarding.busyOnBusy = busyOnBusy as (typeof BUSY_ON_BUSY_OPTIONS)[number];

      const targets = pgTargets.map((t) => t.trim()).filter(Boolean);
      // Always send a full { order, targets } object, even when targets is
      // empty - pgOrder always has a real value (defaults to 'Simultaneous'),
      // so this still matches pickupGroupSchema and lets an intentional
      // clear-to-empty actually reach the server, instead of vanishing as
      // `undefined` (which JSON.stringify drops, leaving the DB column
      // untouched - confirmed this was why a save here couldn't clear a
      // previously-saved group).
      const pickup_group = { order: pgOrder as (typeof CALL_GROUP_ORDERS)[number], targets };

      return api(`${endpoint}/${row.id}`, {
        method: 'PATCH',
        // call_forwarding/delegates/pickup_group are always sent (even {}/[])
        // so this dialog can explicitly clear a previously-designed setting,
        // not just add one.
        body: JSON.stringify({ call_forwarding, pickup_group, delegates }),
      });
    },
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const addPgTarget = () => setPgTargets((t) => [...t, '']);
  const updatePgTarget = (i: number, value: string) => setPgTargets((t) => t.map((x, idx) => (idx === i ? value : x)));
  const removePgTarget = (i: number) => setPgTargets((t) => t.filter((_, idx) => idx !== i));

  const addDelegate = () =>
    setDelegates((d) => [
      ...d,
      { delegateUpn: '', makeCalls: true, receiveCalls: true, manageSettings: false, pickUpHeldCalls: true, joinActiveCalls: true },
    ]);
  const updateDelegate = (i: number, patch: Partial<CallDelegate>) =>
    setDelegates((d) => d.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeDelegate = (i: number) => setDelegates((d) => d.filter((_, idx) => idx !== i));

  const triStateDropdown = (value: TriState, onChange: (v: TriState) => void) => (
    <Dropdown
      value={value === 'on' ? 'On' : value === 'off' ? 'Off' : '— not set —'}
      selectedOptions={[value]}
      onOptionSelect={(_, d) => onChange((d.optionValue as TriState) ?? 'unset')}
      className={ls.minW140}
    >
      <Option value="unset">— not set —</Option>
      <Option value="off">Off</Option>
      <Option value="on">On</Option>
    </Dropdown>
  );

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={ls.maxW640}>
        <DialogBody>
          <DialogTitle>Calling settings — {String(row.upn)}</DialogTitle>
          <DialogContent>
            <div className={ls.gridGap16MinW560}>
              <div>
                <Text weight="semibold">Forwarding</Text>
                <div className={ls.flexWrapItemsEndGap8Mt6}>
                  <Field label="Status">{triStateDropdown(fwdMode, setFwdMode)}</Field>
                  {fwdMode === 'on' && (
                    <>
                      <Field label="Type">
                        <Dropdown value={fwdType} selectedOptions={[fwdType]} onOptionSelect={(_, d) => setFwdType(d.optionValue ?? '')}>
                          {CALL_FORWARDING_TYPES.map((t) => (
                            <Option key={t} value={t}>
                              {t}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                      <Field label="Target type">
                        <Dropdown
                          value={fwdTargetType}
                          selectedOptions={[fwdTargetType]}
                          onOptionSelect={(_, d) => setFwdTargetType(d.optionValue ?? '')}
                        >
                          {CALL_TARGET_TYPES.map((t) => (
                            <Option key={t} value={t}>
                              {t}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                      {fwdTargetType === 'SingleTarget' && (
                        <Field label="Target (user, SIP address or number)">
                          <UpnAutocomplete tenantId={tenantId} value={fwdTarget} onChange={setFwdTarget} className={ls.minW220} />
                        </Field>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div>
                <Text weight="semibold">Unanswered calls</Text>
                <div className={ls.flexWrapItemsEndGap8Mt6}>
                  <Field label="Status">{triStateDropdown(unaMode, setUnaMode)}</Field>
                  {unaMode === 'on' && (
                    <>
                      <Field label="Ring for">
                        <Dropdown
                          value={`${unaDelay}s`}
                          selectedOptions={[String(unaDelay)]}
                          onOptionSelect={(_, d) => setUnaDelay(Number(d.optionValue) || 20)}
                        >
                          {UNANSWERED_DELAYS.map((s) => (
                            <Option key={s} value={String(s)} text={`${s}s`}>
                              {s}s
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                      <Field label="Target type">
                        <Dropdown
                          value={unaTargetType}
                          selectedOptions={[unaTargetType]}
                          onOptionSelect={(_, d) => setUnaTargetType(d.optionValue ?? '')}
                        >
                          {CALL_TARGET_TYPES.map((t) => (
                            <Option key={t} value={t}>
                              {t}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                      {unaTargetType === 'SingleTarget' && (
                        <Field label="Target (user, SIP address or number)">
                          <UpnAutocomplete tenantId={tenantId} value={unaTarget} onChange={setUnaTarget} className={ls.minW220} />
                        </Field>
                      )}
                    </>
                  )}
                </div>
              </div>

              <Field label="Busy on busy" hint="What happens to a new call while already on one">
                <Dropdown
                  value={BUSY_ON_BUSY_OPTIONS.find((o) => o === busyOnBusy) ?? '— not set —'}
                  selectedOptions={[busyOnBusy || 'unset']}
                  onOptionSelect={(_, d) => setBusyOnBusy(d.optionValue === 'unset' ? '' : d.optionValue ?? '')}
                  className={ls.maxW260}
                >
                  <Option value="unset">— not set —</Option>
                  {BUSY_ON_BUSY_OPTIONS.map((o) => (
                    <Option key={o} value={o}>
                      {o}
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              <div>
                <div className={ls.flexItemsCenterJustifySpacebetween}>
                  <Text weight="semibold">Pickup group (call group)</Text>
                  <Button size="small" appearance="subtle" disabled={pgTargets.length >= 25} onClick={addPgTarget}>
                    Add member
                  </Button>
                </div>
                <div className={ls.mt6}>
                  <Field label="Order">
                    <Dropdown value={pgOrder} selectedOptions={[pgOrder]} onOptionSelect={(_, d) => setPgOrder(d.optionValue ?? '')} className={ls.maxW200}>
                      {CALL_GROUP_ORDERS.map((o) => (
                        <Option key={o} value={o}>
                          {o}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                </div>
                {pgTargets.map((t, i) => (
                  <div key={i} className={ls.flexItemsCenterGap8Mt6}>
                    <UpnAutocomplete tenantId={tenantId} value={t} onChange={(v) => updatePgTarget(i, v)} className={ls.minW220} />
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => removePgTarget(i)} />
                  </div>
                ))}
                {pgTargets.length === 0 && (
                  <Text size={200} className={ls.blockMt6Muted}>
                    No members - saving now will clear a previously-saved group on next deploy.
                  </Text>
                )}
              </div>

              <div>
                <div className={ls.flexItemsCenterJustifySpacebetween}>
                  <Text weight="semibold">Delegates</Text>
                  <Button size="small" appearance="subtle" disabled={delegates.length >= 25} onClick={addDelegate}>
                    Add delegate
                  </Button>
                </div>
                {delegates.map((d, i) => (
                  <div key={i} className={ls.flexWrapItemsCenterGap8Mt6}>
                    <UpnAutocomplete
                      tenantId={tenantId}
                      value={d.delegateUpn}
                      onChange={(v) => updateDelegate(i, { delegateUpn: v })}
                      placeholder="delegate@contoso.com"
                      className={ls.minW220}
                    />
                    <Checkbox label="Make calls" checked={d.makeCalls} onChange={(_, ev) => updateDelegate(i, { makeCalls: !!ev.checked })} />
                    <Checkbox label="Receive calls" checked={d.receiveCalls} onChange={(_, ev) => updateDelegate(i, { receiveCalls: !!ev.checked })} />
                    <Checkbox label="Manage settings" checked={d.manageSettings} onChange={(_, ev) => updateDelegate(i, { manageSettings: !!ev.checked })} />
                    <Checkbox label="Pick up held calls" checked={d.pickUpHeldCalls} onChange={(_, ev) => updateDelegate(i, { pickUpHeldCalls: !!ev.checked })} />
                    <Checkbox label="Join active calls" checked={d.joinActiveCalls} onChange={(_, ev) => updateDelegate(i, { joinActiveCalls: !!ev.checked })} />
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => removeDelegate(i)} />
                  </div>
                ))}
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

/* ----------------------- call queue settings dialog ----------------------- */
