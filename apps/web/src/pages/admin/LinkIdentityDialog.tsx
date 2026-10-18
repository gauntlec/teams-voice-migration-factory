import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Spinner, Text, makeStyles, shorthands } from '@fluentui/react-components';
import type { SsoIdentityView, SsoLinkRequestView, SsoSettingsView } from '@tvmf/shared';
import { api } from '../../api';
import { DangerText, MutedText } from '../../components/ui';
import { useNotify } from '../../hooks/useNotify';

const useStyles = makeStyles({
  body: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', ...shorthands.gap('14px'), minWidth: 'min(520px, 100%)' },
  line: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', ...shorthands.gap('8px', '12px') },
  grow: { flex: 1, minWidth: '180px' },
  manual: { display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', ...shorthands.gap('8px') },
});

/**
 * Users > Link to provider identity (docs/SSO.md 4.4). A person is NEVER matched to a local account by email: this is the one place an
 * administrator says "this person at that provider is this user". People who tried to sign in and were refused because the email already
 * exists are listed, so nobody has to look up a provider's subject id by hand.
 */
export function LinkIdentityDialog({ user, onClose }: { user: { id: string; email: string; display_name: string; role: string }; onClose: () => void }) {
  const s = useStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const [err, setErr] = useState<string | null>(null);
  const [providerId, setProviderId] = useState('');
  const [subject, setSubject] = useState('');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['sso-identities', user.id] });
    qc.invalidateQueries({ queryKey: ['sso-link-requests', user.id] });
    qc.invalidateQueries({ queryKey: ['sso-settings'] });
  };
  const identities = useQuery({ queryKey: ['sso-identities', user.id], queryFn: () => api<SsoIdentityView[]>(`/sso/users/${user.id}/identities`) });
  const waiting = useQuery({ queryKey: ['sso-link-requests', user.id], queryFn: () => api<SsoLinkRequestView[]>(`/sso/link-requests?userId=${user.id}`) });
  const settings = useQuery({ queryKey: ['sso-settings'], queryFn: () => api<SsoSettingsView>('/sso/settings') });
  const providers = settings.data?.providers ?? [];

  const link = useMutation({
    mutationFn: (body: { requestId: string } | { providerId: string; subject: string }) => api(`/sso/users/${user.id}/identities`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setErr(null);
      setSubject('');
      refresh();
      notify(`${user.display_name} can now sign in through that provider`);
    },
    onError: (e) => setErr((e as Error).message),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => api(`/sso/identities/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      notify('Link removed, and that person is signed out');
    },
    onError: (e) => setErr((e as Error).message),
  });

  const mine = (waiting.data ?? []).filter((w) => w.matchesUser);
  const others = (waiting.data ?? []).filter((w) => !w.matchesUser);

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Link {user.display_name} to a provider identity</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <MutedText>
                A person at a single sign-on provider is never matched to an existing account just because the email is the same: that could let someone take over an account. Linking says, on purpose, that this person at that provider is {user.email}. From then on their role comes from the provider (up to the highest role you allow for it), and their local password, if they have one, stays.
              </MutedText>

              <Text weight="semibold">Linked now</Text>
              {identities.isLoading ? (
                <Spinner size="tiny" />
              ) : (identities.data ?? []).length === 0 ? (
                <MutedText>Not linked to any provider.</MutedText>
              ) : (
                (identities.data ?? []).map((i) => (
                  <div key={i.id} className={s.line}>
                    <Text className={s.grow}>
                      {i.providerName}
                      {i.email ? ` (${i.email})` : ''}
                    </Text>
                    <MutedText>{i.lastLoginAt ? `Last sign-in ${new Date(i.lastLoginAt).toLocaleString()}` : 'Never signed in'}</MutedText>
                    <Button size="small" disabled={unlink.isPending} onClick={() => unlink.mutate(i.id)}>
                      Unlink
                    </Button>
                  </div>
                ))
              )}

              <Text weight="semibold">Waiting to be linked</Text>
              {waiting.isLoading ? (
                <Spinner size="tiny" />
              ) : (waiting.data ?? []).length === 0 ? (
                <MutedText>Nobody is waiting. When someone signs in through a provider with an email that already has an account here, they are refused and appear here.</MutedText>
              ) : (
                <>
                  {[...mine, ...others].map((w) => (
                    <div key={w.id} className={s.line}>
                      <Text className={s.grow}>
                        {w.displayName ?? w.email} ({w.email}) at {w.providerName}
                      </Text>
                      {w.matchesUser && (
                        <Badge appearance="tint" color="success">
                          Same email
                        </Badge>
                      )}
                      <Button size="small" appearance={w.matchesUser ? 'primary' : 'secondary'} disabled={link.isPending} onClick={() => link.mutate({ requestId: w.id })}>
                        Link to {user.display_name}
                      </Button>
                    </div>
                  ))}
                  {others.length > 0 && <MutedText>Only link someone whose identity you have checked. Different email addresses are listed too, in case a person's address changed.</MutedText>}
                </>
              )}

              {providers.length > 0 && (
                <>
                  <Text weight="semibold">Or enter the provider's identifier</Text>
                  <div className={s.manual}>
                    <Field label="Provider">
                      <Select value={providerId} onChange={(_, d) => setProviderId(d.value)}>
                        <option value="">Choose…</option>
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Subject (the provider's id for this person)">
                      <Input value={subject} onChange={(_, d) => setSubject(d.value)} />
                    </Field>
                    <Button disabled={!providerId || !subject.trim() || link.isPending} onClick={() => link.mutate({ providerId, subject: subject.trim() })}>
                      Link
                    </Button>
                  </div>
                </>
              )}
              {err && <DangerText>{err}</DangerText>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              Done
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
