import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  Option,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { Paginated } from '@tvmf/shared';
import { api, ApiError } from '../api';

/**
 * "Set up a new resource account" - a small nested dialog used by the AA/CQ
 * wizards' Review step ("which phone number/identity will answer this?") so
 * a brand-new planned resource account, with a real inventory phone number
 * attached, can be created without leaving the wizard or making a separate
 * trip to the Resource accounts tab. `kind` is fixed by the caller (never
 * user-editable here) - an Auto Attendant wizard always creates an
 * 'auto_attendant' resource account, a Call Queue wizard a 'call_queue' one,
 * matching the Resource accounts tab's own `kind` field.
 *
 * Creates a real discovery_resource_accounts row, then - if a number was
 * picked - attaches it via the same POST .../resource-accounts/:id/numbers
 * route the Resource accounts tab's own "Numbers" button uses (a resource
 * account can hold several numbers, so that's a separate call, not a field
 * on the create body). Invalidates the same query keys SiteWorkspace.tsx
 * uses for the Resource accounts tab (`ras`), the wizard's own lightweight
 * choices list (`site-ras-lite`), and the available-numbers pool
 * (`site-avail-numbers`), so every list reflects the new row immediately
 * without needing an explicit refresh callback threaded through.
 */
export function ResourceAccountCreateDialog({
  open,
  onOpenChange,
  base,
  tenantId,
  siteId,
  kind,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  tenantId: string;
  siteId: string;
  kind: 'auto_attendant' | 'call_queue';
  onCreated: (row?: { id: string; name: string }) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const avail = useQuery({
    queryKey: ['site-avail-numbers', tenantId, siteId],
    enabled: open && !!tenantId && !!siteId,
    queryFn: () =>
      api<Paginated<{ id: string; e164: string }>>(`${base}/numbers?siteId=${siteId}&status=available&limit=200`),
  });
  const numberChoices = avail.data?.items ?? [];

  const reset = () => {
    setName('');
    setPhoneNumberId('');
    setError(null);
  };

  const save = useMutation({
    mutationFn: async () => {
      const ra = await api<{ id: string; name: string }>(`${base}/resource-accounts`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId, name, kind }),
      });
      if (phoneNumberId) {
        await api(`${base}/resource-accounts/${ra.id}/numbers`, {
          method: 'POST',
          body: JSON.stringify({ phone_number_id: phoneNumberId }),
        });
      }
      return ra;
    },
    onSuccess: (ra) => {
      qc.invalidateQueries({ queryKey: ['ras', tenantId, siteId] });
      qc.invalidateQueries({ queryKey: ['site-ras-lite', tenantId, siteId] });
      qc.invalidateQueries({ queryKey: ['site-avail-numbers', tenantId, siteId] });
      reset();
      onOpenChange(false);
      onCreated(ra);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        onOpenChange(d.open);
        if (!d.open) reset();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New resource account</DialogTitle>
          <DialogContent style={{ display: 'grid', gap: 12 }}>
            <Field label="Name of service" required>
              <Input value={name} placeholder="Sales Line" onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label="Phone number (optional - can be set later)">
              <Dropdown
                value={numberChoices.find((n) => n.id === phoneNumberId)?.e164 ?? '— none yet —'}
                selectedOptions={phoneNumberId ? [phoneNumberId] : []}
                onOptionSelect={(_, d) => setPhoneNumberId(d.optionValue ?? '')}
              >
                <Option value="">— none yet —</Option>
                {numberChoices.map((n) => (
                  <Option key={n.id} value={n.id}>
                    {n.e164}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            {error && (
              <Text block style={{ color: tokens.colorPaletteRedForeground1 }}>
                {error}
              </Text>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" disabled={save.isPending}>
                Cancel
              </Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
