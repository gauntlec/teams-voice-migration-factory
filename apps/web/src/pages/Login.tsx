import { useState } from 'react';
import {
  Body1,
  Button,
  Card,
  Field,
  Input,
  Spinner,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { Wordmark } from '../components/Logo';

const useStyles = makeStyles({
  root: {
    display: 'grid',
    placeItems: 'center',
    minHeight: '100vh',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  card: { width: '360px', ...shorthands.padding('28px'), ...shorthands.gap('16px') },
  brand: { color: tokens.colorBrandForeground1 },
});

export function Login() {
  const s = useStyles();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needMfa, setNeedMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const outcome = await login(email, password, totp || undefined);
      if (outcome === 'mfa') setNeedMfa(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && /MFA code required/i.test(err.message)) {
        setNeedMfa(true);
      } else if (err instanceof ApiError && err.status === 401 && /MFA/i.test(err.message)) {
        setNeedMfa(true);
        setError('That code was incorrect or expired. Check your authenticator and try the current code.');
      } else {
        setError(err instanceof Error ? err.message : 'Sign in failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.root}>
      <Card className={s.card}>
        <Wordmark size={24} />
        <Body1>Sign in to continue.</Body1>
        <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
          <Field label="Email" required>
            <Input type="email" value={email} onChange={(_, d) => setEmail(d.value)} autoFocus />
          </Field>
          <Field label="Password" required>
            <Input
              type="password"
              value={password}
              onChange={(_, d) => setPassword(d.value)}
            />
          </Field>
          {needMfa && (
            <Field label="Authenticator code" hint="6-digit code from your authenticator app" required>
              <Input
                value={totp}
                onChange={(_, d) => setTotp(d.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
              />
            </Field>
          )}
          {error && <Body1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Body1>}
          <Button appearance="primary" type="submit" disabled={busy}>
            {busy ? <Spinner size="tiny" /> : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
