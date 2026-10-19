import { useEffect, useRef, useState } from 'react';
import { Button, Card, Spinner, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { STAFF_WAIT_MESSAGES, type StaffWaitStatus } from '@tvmf/shared';
import { Wordmark } from '../components/Logo';

const useStyles = makeStyles({
  page: { minHeight: '100vh', display: 'grid', placeItems: 'center', backgroundColor: tokens.colorNeutralBackground2, ...shorthands.padding('24px', '16px') },
  card: { width: 'min(520px, 100%)', display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM, ...shorthands.padding('24px') },
  muted: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

const POLL_MS = 4000;

/** "04:12 pm" or similar, in the person's own clock. */
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Where a Voxshift staff sign-in waits when this installation needs an administrator's approval (docs/SSO.md 4.3a). No sign-in yet: the cookie the
 * sign-in set (HttpOnly, so this page never sees it) says which request is theirs. The page asks every few seconds; once approved it asks for the
 * session once and goes on to the page the person wanted.
 */
export function StaffAccessWait() {
  const s = useStyles();
  const [status, setStatus] = useState<StaffWaitStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const going = useRef(false);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/auth/staff-access/status', { credentials: 'include', cache: 'no-store' });
        if (!res.ok) throw new Error('status');
        const next = (await res.json()) as StaffWaitStatus;
        if (stop) return;
        setStatus(next);
        if (next.state === 'approved' && !going.current) {
          going.current = true;
          const done = await fetch('/api/auth/staff-access/continue', { method: 'POST', credentials: 'include' });
          const body = (await done.json().catch(() => ({}))) as { ok?: boolean; redirectTo?: string };
          if (body.ok) {
            // A full page load, so the app starts from the session cookie that has just been set.
            window.location.assign(body.redirectTo ?? '/');
            return;
          }
          going.current = false;
          setFailed(true);
          return;
        }
        if (next.state !== 'pending' && next.state !== 'approved') return; // an end state: stop asking
      } catch {
        // a hiccup: keep waiting and try again
      }
      if (!stop) setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, []);

  const waiting = !status || status.state === 'pending' || (status.state === 'approved' && !failed);
  return (
    <div className={s.page}>
      <Card className={s.card}>
        <Wordmark />
        {waiting ? (
          <>
            <Text weight="semibold" size={500} as="h1">
              Waiting for approval
            </Text>
            <Text>
              This installation asks its administrators to approve sign-ins from Voxshift staff. They have been told. Keep this page open: when they approve, you are signed in here automatically.
            </Text>
            {status?.state === 'approved' ? <Spinner size="tiny" label="Approved. Signing you in…" /> : <Spinner size="tiny" label="Waiting for an administrator…" />}
            {status?.until && status.state === 'pending' && <Text className={s.muted}>If nobody answers, the request lapses at {clock(status.until)} and you can ask again.</Text>}
          </>
        ) : (
          <>
            <Text weight="semibold" size={500} as="h1">
              {failed ? 'Could not sign you in' : 'Not signed in'}
            </Text>
            <Text>{failed ? 'The approval could not be used (it may have been withdrawn, or already used). Sign in again to ask again.' : STAFF_WAIT_MESSAGES[status!.state as keyof typeof STAFF_WAIT_MESSAGES]}</Text>
            <div className={s.actions}>
              <Button appearance="primary" as="a" href="/">
                Back to sign in
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
