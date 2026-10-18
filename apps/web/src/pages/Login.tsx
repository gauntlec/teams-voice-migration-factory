import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Body1,
  Button,
  Card,
  Divider,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import { SSO_PUBLIC_ERRORS, isSsoPublicError, type PublicSsoProvider, type PublicSsoProviders } from '@tvmf/shared';
import { useAuth } from '../auth';
import { ApiError, api } from '../api';
import { Wordmark } from '../components/Logo';
import { MutedText } from '../components/ui';

/** Why single sign-on did not work, if the page was reached from a refused sign-in (`/?sso_error=<code>`). The code is looked up in a fixed list; nothing from the address is shown as it is. */
function readSsoError(): string | null {
  try {
    const code = new URLSearchParams(window.location.search).get('sso_error');
    return code === null ? null : SSO_PUBLIC_ERRORS[isSsoPublicError(code) ? code : 'failed'];
  } catch {
    return null;
  }
}

/** Takes the code out of the address once it has been read, so a reload or a bookmark does not show the message again. */
function forgetSsoError() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('sso_error')) return;
    params.delete('sso_error');
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  } catch {
    /* the message simply stays in the address */
  }
}

const providerLabel = (p: PublicSsoProvider) => `Sign in with ${p.name}`;

/** Where to come back to after signing in: the page that asked for sign-in, unless that was the front page. */
function returnToParam(): string {
  const here = `${window.location.pathname}${window.location.search}`;
  return here === '/' || window.location.pathname === '/login' ? '' : `&returnTo=${encodeURIComponent(here)}`;
}

const useLocalStyles = makeStyles({
  gridGap14: { display: "grid", ...shorthands.gap('14px') },
  danger: { color: tokens.colorPaletteRedForeground1 },
});


const useStyles = makeStyles({
  root: {
    display: 'grid',
    placeItems: 'center',
    minHeight: '100vh',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  card: { width: '360px', maxWidth: 'calc(100vw - 32px)', ...shorthands.padding('28px'), ...shorthands.gap('16px') },
  providers: { display: 'grid', ...shorthands.gap('8px') },
  adminLink: { justifySelf: 'start' },
  brand: { color: tokens.colorBrandForeground1 },
});

export function Login() {
  const ls = useLocalStyles();
  const s = useStyles();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needMfa, setNeedMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ssoError] = useState(readSsoError);
  useEffect(forgetSsoError, []);
  // With single sign-on the password form can be switched off; break-glass administrators reach it from the "Administrator sign-in" link.
  const [showLocal, setShowLocal] = useState(false);
  const providers = useQuery({ queryKey: ['sso-providers'], queryFn: () => api<PublicSsoProviders>('/auth/providers'), retry: false });
  const list = providers.data?.providers ?? [];
  const localPasswords = providers.data?.localPasswords ?? true;
  const formVisible = localPasswords || showLocal;

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
        {ssoError && (
          <MessageBar intent="error">
            <MessageBarBody>{ssoError}</MessageBarBody>
          </MessageBar>
        )}
        {providers.isLoading && <Spinner size="tiny" />}
        {list.length > 0 && (
          <div className={s.providers}>
            {list.map((p) => (
              <Button key={p.id} as="a" href={`/api/auth/oidc/login?provider=${encodeURIComponent(p.id)}${returnToParam()}`} appearance={localPasswords || showLocal ? 'secondary' : 'primary'}>
                {providerLabel(p)}
              </Button>
            ))}
          </div>
        )}
        {list.length > 0 && formVisible && <Divider>or sign in with a password</Divider>}
        {!formVisible && !providers.isLoading && (
          <Button appearance="transparent" size="small" className={s.adminLink} onClick={() => setShowLocal(true)}>
            Administrator sign-in
          </Button>
        )}
        {showLocal && !localPasswords && <MutedText size={200}>This is for local administrator accounts only, for when single sign-on is not available.</MutedText>}
        {formVisible && (
          <form onSubmit={submit} className={ls.gridGap14}>
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
            {error && <Body1 className={ls.danger}>{error}</Body1>}
            <Button appearance="primary" type="submit" disabled={busy}>
              {busy ? <Spinner size="tiny" /> : 'Sign in'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
