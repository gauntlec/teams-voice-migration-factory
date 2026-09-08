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
  qr: {
    display: 'block',
    width: '200px',
    height: '200px',
    ...shorthands.margin('0', 'auto'),
    ...shorthands.padding('8px'),
    backgroundColor: '#ffffff',
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  secret: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.padding('8px', '12px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    wordBreak: 'break-all',
    letterSpacing: '1px',
  },
});

interface EnrolData {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export function EnrolTotp() {
  const s = useStyles();
  const { confirmEnrol, logout } = useAuth();
  const [data, setData] = useState<EnrolData | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<EnrolData>('/auth/totp/start', { method: 'POST' })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to start enrolment'));
  }, []);

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await confirmEnrol(code);
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
          Scan this QR code with an authenticator app (Microsoft Authenticator, Google
          Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.
        </Body1>
        {!data && !error && <Spinner label="Preparing…" />}
        {data && (
          <>
            <img className={s.qr} src={data.qrDataUrl} alt="Two-factor setup QR code" />
            <Button appearance="transparent" size="small" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide setup key' : "Can't scan? Enter a key instead"}
            </Button>
            {showKey && (
              <Field label="Setup key">
                <div className={s.secret}>{data.secret}</div>
              </Field>
            )}
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
