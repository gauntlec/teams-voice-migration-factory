import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Text, Textarea, makeStyles, tokens } from '@fluentui/react-components';
import type { BuildQuickAddResult } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { DangerText } from '../../components/ui';

const useStyles = makeStyles({
  body: { display: 'grid', rowGap: '12px' },
  list: { margin: 0, paddingLeft: '18px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

/**
 * Quick add: the engineer types only UPNs (one per line, or separated by commas) and each user or common area phone is
 * imported from the discovered tenant data - its number, policies and voicemail - instead of being typed in.
 */
export function QuickAddDialog({
  base,
  kind,
  siteId,
  onClose,
  onDone,
}: {
  base: string;
  kind: 'users' | 'caps';
  siteId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const s = useStyles();
  const [text, setText] = useState('');
  const [result, setResult] = useState<BuildQuickAddResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const noun = kind === 'users' ? 'user' : 'common area phone';
  const upns = text.split(/[\s,;]+/).filter(Boolean);
  const add = useMutation({
    mutationFn: () => api<BuildQuickAddResult>(`${base}/${kind}/quick-add`, { method: 'POST', body: JSON.stringify({ site_id: siteId, upns }) }),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
      onDone();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Quick add failed'),
  });

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Quick add {kind === 'users' ? 'users' : 'common area phones'}</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              {!result ? (
                <>
                  <Text size={200}>
                    Type only the UPNs. Each {noun} is imported from the discovered tenant data: its number, its current policies and its voicemail settings
                    {kind === 'caps' ? ', and its name' : ''}. Change anything afterwards in the grid.
                  </Text>
                  <Field label="UPNs" hint="One per line, or separated by commas. Up to 200.">
                    <Textarea value={text} onChange={(_, d) => setText(d.value)} rows={8} resize="vertical" placeholder={'jo.bloggs@contoso.com\nsam.jones@contoso.com'} />
                  </Field>
                  {error && <DangerText>{error}</DangerText>}
                </>
              ) : (
                <>
                  {result.added.length > 0 && (
                    <div>
                      <Text weight="semibold">Added ({result.added.length})</Text>
                      <ul className={s.list}>
                        {result.added.map((a) => (
                          <li key={a.id}>
                            {a.displayName ? `${a.displayName} · ` : ''}
                            {a.upn}
                            {a.number ? ` · ${a.number}` : ' · no number yet'}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {result.alreadyThere.length > 0 && (
                    <div>
                      <Text weight="semibold">Already on this site ({result.alreadyThere.length})</Text>
                      <ul className={s.list}>{result.alreadyThere.map((u) => <li key={u}>{u}</li>)}</ul>
                    </div>
                  )}
                  {result.notFound.length > 0 && (
                    <div>
                      <Text weight="semibold">Not added ({result.notFound.length})</Text>
                      <Text size={200} className={s.muted} block>
                        Not in the discovered tenant data, or not a valid UPN. Run a Discovery sync if the account is new, or add it with Add.
                      </Text>
                      <ul className={s.list}>{result.notFound.map((u) => <li key={u}>{u}</li>)}</ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {!result ? (
              <>
                <Button appearance="secondary" onClick={onClose}>Cancel</Button>
                <Button appearance="primary" disabled={upns.length === 0 || add.isPending} onClick={() => add.mutate()}>
                  {add.isPending ? 'Adding…' : `Add ${upns.length || ''} ${noun}${upns.length === 1 ? '' : 's'}`.replace('  ', ' ')}
                </Button>
              </>
            ) : (
              <>
                <Button appearance="secondary" onClick={() => { setResult(null); setText(result.notFound.join('\n')); }} disabled={result.notFound.length === 0}>
                  Try the rest again
                </Button>
                <Button appearance="primary" onClick={onClose}>Done</Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
