import { useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Card,
  Field,
  Input,
  Spinner,
  Text,
  Title2,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import { api } from '../api';
import { useAuth } from '../auth';

const useStyles = makeStyles({
  root: { display: 'grid', placeItems: 'center', minHeight: '100vh', backgroundColor: tokens.colorNeutralBackground2 },
  card: { width: '440px', ...shorthands.padding('28px'), ...shorthands.gap('16px') },
  secret: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.padding('8px', '12px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    wordBreak: 'break-all',
  },
});

export function EnrolTotp() {
  const s = useStyles();
  const { completeEnrol, logout } = useAuth();
  const [data, setData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ secret: string; otpauthUrl: string }>('/auth/totp/start', { method: 'POST' })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to start enrolment'));
  }, []);

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ totp: code }) });
      await completeEnrol();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Incorrect code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.root}>
      <Card className={s.card}>
        <Title2>Set up two-factor authentication</Title2>
        <Body1>
          Multi-factor authentication is required. Add this account to an authenticator app
          (Microsoft Authenticator, 1Password, Authy…), then enter the 6-digit code.
        </Body1>
        {!data && !error && <Spinner label="Preparing…" />}
        {data && (
          <>
            <Field label="Setup key (enter manually)">
              <div className={s.secret}>{data.secret}</div>
            </Field>
            <Text size={200}>
              Or use this otpauth URL:{' '}
              <span style={{ wordBreak: 'break-all' }}>{data.otpauthUrl}</span>
            </Text>
            <form onSubmit={confirm} style={{ display: 'grid', gap: 12 }}>
              <Field label="Authenticator code" required>
                <Input
                  value={code}
                  onChange={(_, d) => setCode(d.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoFocus
                />
              </Field>
              {error && <Body1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Body1>}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button appearance="primary" type="submit" disabled={busy || code.length !== 6}>
                  {busy ? <Spinner size="tiny" /> : 'Verify & continue'}
                </Button>
                <Button appearance="subtle" onClick={() => void logout()}>
                  Cancel
                </Button>
              </div>
            </form>
          </>
        )}
        {error && !data && <Body1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Body1>}
      </Card>
    </div>
  );
}
