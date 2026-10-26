import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Dropdown, Field, Input, Option, Switch, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { USER_NAME_EXTENSIONS } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { UpnAutocomplete } from '../../components/UpnAutocomplete';
import type { Row } from '../../components/records';
import { DangerText } from '../../components/ui';

const useStyles = makeStyles({
  surface: { maxWidth: '600px' },
  body: { display: 'grid', ...shorthands.gap('14px') },
  person: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px') },
  upn: { minWidth: '240px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

/**
 * Who may change this auto attendant or call queue (authorised users), which of them are hidden, and the settings Microsoft
 * only offers in PowerShell: the auto attendant's dial-by-name extension, the queue's AI voicemail triage template
 * (shared/voice-app-access.ts). "Managed by Voxshift" off = null: deployments leave whatever Teams has.
 */
export function AccessDialog({ tenantId, endpoint, kind, row, onClose, onSaved }: { tenantId: string; endpoint: string; kind: 'auto_attendant' | 'call_queue'; row: Row; onClose: () => void; onSaved: () => void }) {
  const s = useStyles();
  const initial = Array.isArray(row.authorized_users) ? (row.authorized_users as string[]) : null;
  const initialHidden = new Set(((row.hide_authorized_users as string[] | null) ?? []).map((u) => u.toLowerCase()));
  const [managed, setManaged] = useState(initial !== null);
  const [people, setPeople] = useState<{ upn: string; hidden: boolean }[]>((initial ?? []).map((upn) => ({ upn, hidden: initialHidden.has(upn.toLowerCase()) })));
  const [extension, setExtension] = useState<string>((row.user_name_extension as string | null) ?? '');
  const [triage, setTriage] = useState<string>((row.voicemail_triage_template_id as string | null) ?? '');
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const list = people.map((p) => p.upn.trim()).filter(Boolean);
      const body: Record<string, unknown> = {
        authorized_users: managed ? list : null,
        hide_authorized_users: managed ? people.filter((p) => p.hidden && p.upn.trim()).map((p) => p.upn.trim()) : null,
      };
      if (kind === 'auto_attendant') body.user_name_extension = extension || null;
      else body.voicemail_triage_template_id = triage.trim() || null;
      return api(`${endpoint}/${row.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save'),
  });

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>Access and advanced settings — {String(row.name)}</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Switch
                checked={managed}
                onChange={(_, d) => setManaged(d.checked)}
                label="Manage authorised users in Voxshift"
              />
              <Text size={200} className={s.muted}>
                {managed
                  ? 'The deployment sets exactly these people. An empty list removes everyone.'
                  : 'Off: deployments leave the authorised users Teams already has.'}
              </Text>
              {managed && (
                <div>
                  {people.map((p, i) => (
                    <div key={i} className={s.person}>
                      <UpnAutocomplete tenantId={tenantId} value={p.upn} onChange={(v) => setPeople((ps) => ps.map((x, j) => (j === i ? { ...x, upn: v } : x)))} className={s.upn} />
                      <Checkbox label="Hidden" checked={p.hidden} onChange={(_, d) => setPeople((ps) => ps.map((x, j) => (j === i ? { ...x, hidden: !!d.checked } : x)))} />
                      <Button size="small" appearance="subtle" icon={<DeleteRegular />} aria-label="Remove" onClick={() => setPeople((ps) => ps.filter((_, j) => j !== i))} />
                    </div>
                  ))}
                  <Button size="small" appearance="subtle" disabled={people.length >= 100} onClick={() => setPeople((ps) => [...ps, { upn: '', hidden: false }])}>
                    Add authorised user
                  </Button>
                  <Text size={200} className={s.muted} block>
                    Hidden: the person can still change it, but is not listed as an authorised user. PowerShell only - not shown in Teams Admin Center.
                  </Text>
                </div>
              )}
              {kind === 'auto_attendant' ? (
                <Field label="Dial by name: when two people share a name, also say" hint="PowerShell only - not shown in Teams Admin Center.">
                  <Dropdown
                    value={extension || '— Teams default —'}
                    selectedOptions={[extension || 'unset']}
                    onOptionSelect={(_, d) => setExtension(d.optionValue === 'unset' ? '' : (d.optionValue ?? ''))}
                  >
                    <Option value="unset">— Teams default —</Option>
                    {USER_NAME_EXTENSIONS.map((x) => (
                      <Option key={x} value={x} text={x === 'None' ? 'Nothing (name only)' : `Their ${x.toLowerCase()}`}>
                        {x === 'None' ? 'Nothing (name only)' : `Their ${x.toLowerCase()}`}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              ) : (
                <Field
                  label="Shared voicemail AI triage template ID"
                  hint="Microsoft private preview: only works for customers in the Voice Applications preview. PowerShell only."
                >
                  <Input value={triage} onChange={(_, d) => setTriage(d.value)} placeholder="00000000-0000-0000-0000-000000000000" />
                </Field>
              )}
              {err && <DangerText block>{err}</DangerText>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
