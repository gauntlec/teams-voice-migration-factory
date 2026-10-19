import { useEffect, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';
import { Button, Card, Field, Spinner, Text, Textarea, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Wordmark } from '../components/Logo';

const useStyles = makeStyles({
  page: { minHeight: '100vh', display: 'grid', placeItems: 'center', backgroundColor: tokens.colorNeutralBackground2, ...shorthands.padding('24px', '16px') },
  card: { width: 'min(560px, 100%)', display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM, ...shorthands.padding('24px') },
  muted: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  error: { color: tokens.colorPaletteRedForeground1 },
});

interface Preview {
  customerName: string;
  person: string;
  reference: string;
  title: string;
  status: string;
  canAnswer: boolean;
  canReopen: boolean;
  incidentId: string;
}

/** A plain fetch: this page is reached from an email, signed out, and the signed link is the only credential. */
async function call<T>(method: 'GET' | 'POST', token: string, body?: object): Promise<T> {
  const res = await fetch(method === 'GET' ? `/api/public/incident-response?t=${encodeURIComponent(token)}` : '/api/public/incident-response', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(json.message ?? 'Something went wrong. Please try again.');
  return json as T;
}

/**
 * "Is it fixed?" - where the two links in the resolved-incident email land. No
 * sign-in: the signed link in the address says who is answering and for which
 * incident. Opening the page changes nothing (so an email scanner opening it is
 * harmless); the buttons do.
 */
export function IncidentResponse() {
  const s = useStyles();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const [mode, setMode] = useState<'fixed' | 'broken'>(params.get('a') === 'broken' ? 'broken' : 'fixed');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ status: string; already: boolean } | null>(null);

  useEffect(() => {
    if (!token) return setLoadError('This link is incomplete. Open the incident in Voxshift to answer instead.');
    call<Preview>('GET', token)
      .then(setPreview)
      .catch((e: Error) => setLoadError(e.message));
  }, [token]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await call('POST', token, { t: token, action: mode, note: mode === 'broken' ? note : undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.page}>
      <Card className={s.card}>
        <Wordmark size={22} />
        {!preview && !loadError && <Spinner label="Checking your link…" />}
        {loadError && (
          <>
            <Text weight="semibold">We couldn&apos;t open that link</Text>
            <Text>{loadError}</Text>
            <RouterLink to="/">Sign in to Voxshift</RouterLink>
          </>
        )}
        {preview && !done && (
          <>
            <div>
              <Text size={200} className={s.muted} block>
                {preview.customerName}
              </Text>
              <Text size={500} weight="semibold" block>
                {preview.reference} — {preview.title}
              </Text>
            </div>
            {!preview.canAnswer ? (
              <>
                <Text>
                  {preview.status === 'closed'
                    ? 'This incident was closed more than a week ago, so it can no longer be reopened from here.'
                    : preview.status === 'cancelled' || preview.status === 'duplicate'
                      ? 'This incident is no longer being worked on.'
                      : 'The team is still working on this incident, so there is nothing to confirm yet.'}
                </Text>
                <Text size={200} className={s.muted}>
                  If something is still wrong, raise a new incident in Voxshift.
                </Text>
                <RouterLink to={`/incidents/${preview.incidentId}`}>Open the incident</RouterLink>
              </>
            ) : (
              <>
                <Text>
                  Hello {preview.person.split(' ')[0]}, the team says this is fixed. Is it working for you?
                  {preview.status === 'closed' && ' It has been closed, but you can still tell us it is not.'}
                </Text>
                <div className={s.actions} role="group" aria-label="Your answer">
                  <Button appearance={mode === 'fixed' ? 'primary' : 'secondary'} disabled={preview.status === 'closed'} onClick={() => setMode('fixed')}>
                    Yes, it&apos;s fixed
                  </Button>
                  <Button appearance={mode === 'broken' ? 'primary' : 'secondary'} onClick={() => setMode('broken')}>
                    No, it&apos;s still broken
                  </Button>
                </div>
                {mode === 'broken' && (
                  <Field label="What is still wrong?" required hint="The team will pick it straight back up.">
                    <Textarea value={note} maxLength={4000} rows={4} resize="vertical" onChange={(_, d) => setNote(d.value)} />
                  </Field>
                )}
                {error && <Text className={s.error}>{error}</Text>}
                <div className={s.actions}>
                  <Button appearance="primary" disabled={busy || (mode === 'broken' && !note.trim()) || (mode === 'fixed' && preview.status === 'closed')} onClick={submit}>
                    {busy ? 'Sending…' : mode === 'fixed' ? 'Confirm it is fixed' : 'Tell the team'}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        {preview && done && (
          <>
            <Text size={500} weight="semibold">
              {mode === 'fixed' ? 'Thanks - that is closed.' : 'Thanks - the team has been told.'}
            </Text>
            <Text>
              {done.already
                ? 'This had already been answered, so nothing has changed.'
                : mode === 'fixed'
                  ? `${preview.reference} is closed. If it comes back within a week you can reopen it from the incident page.`
                  : `${preview.reference} is back in progress and an engineer will pick it up. You will be emailed as it moves on.`}
            </Text>
            <RouterLink to={`/incidents/${preview.incidentId}`}>View the incident</RouterLink>
          </>
        )}
      </Card>
    </div>
  );
}
