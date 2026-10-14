import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Dropdown, Field, Option, Spinner, Text } from '@fluentui/react-components';
import { api, ApiError } from '../../api';
import { LoadError } from '../../components/records';

export function EmbeddedShell({ children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return <div style={{ display: 'grid', gap: 16 }}>{children}</div>;
}

/**
 * "Link discovered resource account" - pulls one specific live resource
 * account (not yet in Data Collection at all) straight into this site,
 * without the engineer having to visit Data Collection first. Candidates
 * come from the same tenant-wide preview Data Collection's own Resource
 * accounts import uses (TenantDiscoveryService.importResourceAccountsPreview) -
 * ones whose auto-suggested site matches this workspace sort first, since
 * the live object may not carry this site's own naming convention at all.
 */
export function LinkDiscoveredResourceAccountDialog({
  tid,
  siteId,
  onClose,
  onDone,
}: {
  tid: string;
  siteId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [objectId, setObjectId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ['tdisc', 'import-resource-accounts-preview', tid],
    queryFn: () =>
      api<{ candidates: { id: string; name: string | null; kind: string | null; phone: string | null; suggestedSiteId: string | null }[] }>(
        `/t/${tid}/tenant-discovery/import-resource-accounts/preview`,
      ),
  });
  const candidates = useMemo(() => {
    const items = preview.data?.candidates ?? [];
    return [...items].sort((a, b) => Number(b.suggestedSiteId === siteId) - Number(a.suggestedSiteId === siteId));
  }, [preview.data, siteId]);
  const link = useMutation({
    mutationFn: () =>
      api(`/t/${tid}/build/resource-accounts/import-and-link`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId, object_id: objectId }),
      }),
    onSuccess: onDone,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Link failed'),
  });
  const selected = candidates.find((c) => c.id === objectId);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Link discovered resource account</DialogTitle>
          <DialogContent>
            <div style={{ display: 'grid', gap: 12 }}>
              <Text size={200}>
                Pulls one live resource account that isn't in Data Collection yet straight into this
                site - creates its Data Collection row and populates it here in one step.
              </Text>
              {preview.isLoading ? (
                <Spinner size="tiny" />
              ) : preview.isError ? (
                <LoadError message={(preview.error as Error).message} />
              ) : candidates.length === 0 ? (
                <Text size={200}>Every discovered resource account is already captured.</Text>
              ) : (
                <Field label="Resource account">
                  <Dropdown
                    placeholder="Pick a resource account…"
                    selectedOptions={objectId ? [objectId] : []}
                    value={selected ? `${selected.name ?? '(unnamed)'}${selected.phone ? ` · ${selected.phone}` : ''}` : ''}
                    onOptionSelect={(_, d) => setObjectId(d.optionValue ?? '')}
                  >
                    {candidates.map((c) => (
                      <Option key={c.id} value={c.id} text={c.name ?? c.id}>
                        {c.name ?? '(unnamed)'}
                        {c.phone ? ` · ${c.phone}` : ''}
                        {c.suggestedSiteId === siteId ? ' · suggested for this site' : ''}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              {err && <LoadError message={err} />}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={!objectId || link.isPending} onClick={() => link.mutate()}>
              Link
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
