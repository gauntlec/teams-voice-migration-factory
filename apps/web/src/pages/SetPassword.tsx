import { useState } from 'react';
import {
  Body1,
  Button,
  Card,
  Field,
  Input,
  Spinner,
  Title2,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import { useAuth } from '../auth';
import { Wordmark } from '../components/Logo';

const useStyles = makeStyles({
  root: {
    display: 'grid',
    placeItems: 'center',
    minHeight: '100vh',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  card: { width: '400px', ...shorthands.padding('28px'), ...shorthands.gap('16px') },
});

const MIN = 12;

export function SetPassword() {
  const s = useStyles();
  const { changePassword, logout } = useAuth();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = pw.length > 0 && pw.length < MIN;
  const mismatch = confirm.length > 0 && confirm !== pw;
  const canSubmit = pw.length >= MIN && confirm === pw && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(pw);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set your password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.root}>
      <Card className={s.card}>
        <Wordmark size={22} />
        <Title2>Set your password</Title2>
        <Body1>
          Your account was created with a temporary password. Choose your own password to
          continue — next you&rsquo;ll set up two-factor authentication.
        </Body1>
        <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
          <Field
            label="New password"
            required
            validationState={tooShort ? 'warning' : 'none'}
            validationMessage={tooShort ? `Use at least ${MIN} characters` : undefined}
            hint={!tooShort ? `At least ${MIN} characters` : undefined}
          >
            <Input
              type="password"
              value={pw}
              onChange={(_, d) => setPw(d.value)}
              autoComplete="new-password"
              autoFocus
            />
          </Field>
          <Field
            label="Confirm new password"
            required
            validationState={mismatch ? 'error' : 'none'}
            validationMessage={mismatch ? 'Passwords do not match' : undefined}
          >
            <Input
              type="password"
              value={confirm}
              onChange={(_, d) => setConfirm(d.value)}
              autoComplete="new-password"
            />
          </Field>
          {error && <Body1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Body1>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button appearance="primary" type="submit" disabled={!canSubmit}>
              {busy ? <Spinner size="tiny" /> : 'Save & continue'}
            </Button>
            <Button appearance="subtle" type="button" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
