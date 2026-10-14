import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Dropdown, Field, Input, Option, Spinner, Text, tokens } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { POLICY_KINDS, VOICEMAIL_PROMPT_LANGUAGES, type PolicyKey } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { type Choice } from '../../components/records';

interface BuildTemplateRow {
  id: string;
  site_id: string;
  kind: 'user' | 'cap';
  name: string;
  policy_ids: Record<string, string | null>;
  policies: Record<string, string | null>;
  voicemail_enabled: boolean | null;
  voicemail_language: string | null;
  is_default: boolean;
}

/** The subset of PolicyKeys a Build Template covers - matches the "Standard
 * User Template" example (voice routing, dial plan, calling policy,
 * emergency calling + routing) - not the full 13-key set per-row edit
 * exposes, to keep a template focused on what's actually meant to default. */
const TEMPLATE_POLICY_KEYS: PolicyKey[] = [
  'voice_routing_policy',
  'dial_plan',
  'calling_policy',
  'emergency_calling_policy',
  'emergency_call_routing_policy',
];

const VM_UNSET = '__unset__';

/**
 * A named, reusable preset of policy targets + voicemail defaults for Users
 * or CAPs on one site ("Standard User Template"). The one marked Default
 * seeds every new row Populate creates for that site+kind; any template can
 * also be applied on demand to the rows currently selected in the table.
 */
export function TemplatesDialog({
  open,
  onOpenChange,
  base,
  siteId,
  kind,
  kindLabel,
  policyChoicesByKey,
  selectedIds,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  siteId: string;
  kind: 'user' | 'cap';
  kindLabel: string;
  policyChoicesByKey: Record<string, Choice[]>;
  selectedIds: Set<string>;
  onApplied: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<BuildTemplateRow | 'new' | null>(null);
  const [form, setForm] = useState<{
    name: string;
    policy_ids: Record<string, string>;
    voicemail_enabled: string;
    voicemail_language: string;
    is_default: boolean;
  }>({ name: '', policy_ids: {}, voicemail_enabled: '', voicemail_language: '', is_default: false });
  const [error, setError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const rowsQ = useQuery({
    queryKey: ['build-templates', base, siteId, kind],
    enabled: open,
    queryFn: () => api<BuildTemplateRow[]>(`${base}/templates?siteId=${siteId}&kind=${kind}`),
  });

  const startNew = () => {
    setForm({ name: '', policy_ids: {}, voicemail_enabled: '', voicemail_language: '', is_default: (rowsQ.data ?? []).length === 0 });
    setError(null);
    setEditing('new');
  };
  const startEdit = (tpl: BuildTemplateRow) => {
    const ids: Record<string, string> = {};
    for (const k of TEMPLATE_POLICY_KEYS) if (tpl.policy_ids[k]) ids[k] = tpl.policy_ids[k]!;
    setForm({
      name: tpl.name,
      policy_ids: ids,
      voicemail_enabled: tpl.voicemail_enabled === null ? '' : String(tpl.voicemail_enabled),
      voicemail_language: tpl.voicemail_language ?? '',
      is_default: tpl.is_default,
    });
    setError(null);
    setEditing(tpl);
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        site_id: siteId,
        kind,
        name: form.name,
        // Only the keys actually set in the form - same "only sets, never
        // clears" convention as bulk edit (buildBulkPayload): a null entry
        // here would jsonb-merge as "clear this key" on Apply to already-
        // populated rows, wiping a field the template was never meant to
        // touch. To clear a field the template previously set, delete and
        // recreate the template rather than blanking it back to "— none —".
        policy_ids: Object.fromEntries(TEMPLATE_POLICY_KEYS.filter((k) => form.policy_ids[k]).map((k) => [k, form.policy_ids[k]])),
        voicemail_enabled: form.voicemail_enabled === '' ? null : form.voicemail_enabled === 'true',
        voicemail_language: form.voicemail_language || null,
        is_default: form.is_default,
      };
      return editing === 'new'
        ? api(`${base}/templates`, { method: 'POST', body: JSON.stringify(body) })
        : api(`${base}/templates/${(editing as BuildTemplateRow).id}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['build-templates', base, siteId, kind] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`${base}/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['build-templates', base, siteId, kind] }),
  });

  const apply = useMutation({
    mutationFn: (id: string) =>
      api<{ updated: number }>(`${base}/templates/${id}/apply`, { method: 'POST', body: JSON.stringify({ ids: [...selectedIds] }) }),
    onSuccess: () => {
      setApplyError(null);
      setApplyingId(null);
      onApplied();
    },
    onError: (e) => {
      setApplyError(e instanceof ApiError ? e.message : 'Apply failed');
      setApplyingId(null);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 760 }}>
        <DialogBody>
          <DialogTitle>{kindLabel} templates</DialogTitle>
          <DialogContent>
            <Text size={200} block style={{ marginBottom: 12 }}>
              A named preset applied automatically to new rows Populate creates for this site (the one marked
              Default), or on demand to the rows selected in the table below.
            </Text>
            {rowsQ.isLoading ? (
              <Spinner size="tiny" label="Loading…" />
            ) : (
              <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
                {(rowsQ.data ?? []).map((tpl) => (
                  <div key={tpl.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Text weight={tpl.is_default ? 'semibold' : 'regular'} style={{ flex: 1 }}>
                      {tpl.name}
                      {tpl.is_default && (
                        <Badge appearance="tint" color="brand" size="small" style={{ marginLeft: 6 }}>
                          Default
                        </Badge>
                      )}
                    </Text>
                    <Button
                      size="small"
                      disabled={selectedIds.size === 0 || apply.isPending}
                      onClick={() => {
                        setApplyingId(tpl.id);
                        apply.mutate(tpl.id);
                      }}
                    >
                      {apply.isPending && applyingId === tpl.id ? 'Applying…' : `Apply to ${selectedIds.size} selected`}
                    </Button>
                    <Button size="small" appearance="subtle" onClick={() => startEdit(tpl)}>
                      Edit
                    </Button>
                    <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => del.mutate(tpl.id)} />
                  </div>
                ))}
                {(rowsQ.data ?? []).length === 0 && <Text size={200}>No templates yet.</Text>}
              </div>
            )}
            {applyError && (
              <Text block style={{ color: tokens.colorPaletteRedForeground1, marginBottom: 8 }}>
                {applyError}
              </Text>
            )}

            {editing ? (
              <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, display: 'grid', gap: 12 }}>
                <Field label="Name">
                  <Input value={form.name} placeholder="Standard User Template" onChange={(_, d) => setForm((p) => ({ ...p, name: d.value }))} />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {TEMPLATE_POLICY_KEYS.map((k) => {
                    const label = POLICY_KINDS.find((p) => p.key === k)?.label ?? k;
                    const choices = policyChoicesByKey[k] ?? [];
                    const value = form.policy_ids[k] ?? '';
                    return (
                      <Field key={k} label={label}>
                        <Dropdown
                          value={choices.find((c) => c.value === value)?.label ?? '— none —'}
                          selectedOptions={[value || '']}
                          onOptionSelect={(_, d) => setForm((p) => ({ ...p, policy_ids: { ...p.policy_ids, [k]: d.optionValue ?? '' } }))}
                        >
                          <Option value="">— none —</Option>
                          {choices.map((c) => (
                            <Option key={c.value} value={c.value} text={c.label}>
                              {c.label}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                    );
                  })}
                  <Field label="Voicemail enabled">
                    <Dropdown
                      value={form.voicemail_enabled === 'true' ? 'On' : form.voicemail_enabled === 'false' ? 'Off' : '— unset —'}
                      selectedOptions={[form.voicemail_enabled || VM_UNSET]}
                      onOptionSelect={(_, d) => setForm((p) => ({ ...p, voicemail_enabled: d.optionValue === VM_UNSET ? '' : d.optionValue ?? '' }))}
                    >
                      <Option value={VM_UNSET}>— unset —</Option>
                      <Option value="true">On</Option>
                      <Option value="false">Off</Option>
                    </Dropdown>
                  </Field>
                  <Field label="Voicemail default language">
                    <Dropdown
                      value={VOICEMAIL_PROMPT_LANGUAGES.find((l) => l.code === form.voicemail_language)?.label ?? '— unset —'}
                      selectedOptions={[form.voicemail_language || VM_UNSET]}
                      onOptionSelect={(_, d) => setForm((p) => ({ ...p, voicemail_language: d.optionValue === VM_UNSET ? '' : d.optionValue ?? '' }))}
                    >
                      <Option value={VM_UNSET}>— unset —</Option>
                      {VOICEMAIL_PROMPT_LANGUAGES.map((l) => (
                        <Option key={l.code} value={l.code} text={l.label}>
                          {l.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                </div>
                <Checkbox
                  label="Default - auto-applied when Populate creates a new row"
                  checked={form.is_default}
                  onChange={(_, d) => setForm((p) => ({ ...p, is_default: !!d.checked }))}
                />
                {error && (
                  <Text block style={{ color: tokens.colorPaletteRedForeground1 }}>
                    {error}
                  </Text>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button appearance="primary" disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? 'Saving…' : 'Save'}
                  </Button>
                  <Button appearance="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="small" onClick={startNew}>
                Add template
              </Button>
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

/* ------------------------- calling settings dialog ------------------------- */
