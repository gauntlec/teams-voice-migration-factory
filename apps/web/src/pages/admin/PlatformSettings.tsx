import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Radio, RadioGroup, Switch, Field, Input, MessageBar, MessageBarActions, MessageBarBody, Spinner, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { CopyRegular } from '@fluentui/react-icons';
import { DEFAULT_HUB_URL, HOSTED_BASE_URL, HUB_TOKEN_RE, MAIL_MODE_LABELS, baseUrlWarnings, hubLinkState, normalizeBaseUrl, type BaseUrlView, type HubConnectionView, type MailModeSetting, type MailSettingsView } from '@tvmf/shared';
import { api } from '../../api';
import { Page } from '../../components/Page';
import { LoadError } from '../../components/records';
import { useNotify } from '../../hooks/useNotify';
import { MutedText } from '../../components/ui';

const useLocalStyles = makeStyles({
  body: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', ...shorthands.gap('16px'), ...shorthands.padding('16px') },
  row: { display: 'flex', ...shorthands.gap('12px'), alignItems: 'flex-end', flexWrap: 'wrap' },
  hubRow: { display: 'flex', ...shorthands.gap('12px'), alignItems: 'flex-start', flexWrap: 'wrap' },
  hubButton: { marginTop: '22px' },
  grow: { flex: 1, minWidth: '280px' },
  stack: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', ...shorthands.gap('4px') },
  current: { display: 'flex', ...shorthands.gap('8px'), alignItems: 'center', flexWrap: 'wrap' },
  list: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', ...shorthands.gap('8px') },
  line: { display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr auto', ...shorthands.gap('8px'), alignItems: 'center' },
  code: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
});

/** How this installation sends email: nothing, a mail server of its own, or the Voxshift Hub's mail service. With a test message that proves the saved setup. */
function EmailCard({ mail }: { mail: MailSettingsView }) {
  const s = useLocalStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const [mode, setMode] = useState<MailModeSetting>(mail.mode);
  const [host, setHost] = useState(mail.smtp.host);
  const [port, setPort] = useState(String(mail.smtp.port));
  const [secure, setSecure] = useState(mail.smtp.secure);
  const [user, setUser] = useState(mail.smtp.user);
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState(mail.smtp.from);
  const [fromName, setFromName] = useState(mode === 'hub' ? mail.hubFromName : mail.smtp.fromName);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [test, setTest] = useState<{ state: 'sending' | 'sent' | 'failed'; message?: string } | null>(null);
  const touch = <T,>(set: (v: T) => void) => (v: T) => (set(v), setDirty(true));

  const portNum = Number(port);
  const smtpValid = host.trim().length > 0 && Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 && /^\S+@\S+\.\S+$/.test(from.trim());
  const valid = mode !== 'smtp' || smtpValid;

  const save = useMutation({
    mutationFn: () => {
      const body =
        mode === 'none'
          ? { mode }
          : mode === 'hub'
            ? { mode, fromName: fromName.trim() || 'Voxshift' }
            : { mode, smtp: { host: host.trim(), port: portNum, secure, user: user.trim(), ...(password ? { password } : {}), from: from.trim(), fromName: fromName.trim() || 'Voxshift' } };
      return api<BaseUrlView>('/platform/mail', { method: 'PUT', body: JSON.stringify(body) });
    },
    onSuccess: (v) => {
      setErr(null);
      setPassword('');
      setDirty(false);
      qc.setQueryData(['platform-settings'], v);
      notify('Email settings saved');
    },
    onError: (e) => setErr((e as Error).message),
  });

  const sendTest = async () => {
    setTest({ state: 'sending' });
    try {
      const { id } = await api<{ id: string }>('/platform/mail/test', { method: 'POST', body: JSON.stringify({ to: testTo.trim() }) });
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const r = await api<{ status: string; error: string | null }>(`/platform/mail/test/${id}`);
        if (r.status === 'sent') return setTest({ state: 'sent', message: `Sent to ${testTo.trim()}. Check the inbox (and junk mail).` });
        if (r.status === 'failed') return setTest({ state: 'failed', message: r.error ?? 'It could not be sent.' });
        if (r.status === 'skipped') return setTest({ state: 'failed', message: r.error ?? 'It was skipped.' });
      }
      setTest({ state: 'failed', message: 'It is still waiting to be sent. Check Administration > Email log.' });
    } catch (e) {
      setTest({ state: 'failed', message: (e as Error).message });
    }
  };

  return (
    <Card>
      <div className={s.body}>
        <div className={s.stack}>
          <Text weight="semibold">How email is sent</Text>
          <MutedText>Invitations, password resets and notices are sent the way you choose here. The on/off switch above stops all of it.</MutedText>
        </div>
        {mail.source === 'environment' && (
          <MessageBar intent="info">
            <MessageBarBody>These settings are coming from this installation's configuration file (SMTP_* in its .env). Saving here replaces them; nothing in the file needs changing.</MessageBarBody>
          </MessageBar>
        )}
        <RadioGroup value={mode} onChange={(_, d) => touch(setMode)(d.value as MailModeSetting)}>
          <Radio value="smtp" label={MAIL_MODE_LABELS.smtp} />
          <Radio value="hub" label={MAIL_MODE_LABELS.hub} disabled={!mail.hub.connected} />
          <Radio value="none" label={MAIL_MODE_LABELS.none} />
        </RadioGroup>

        {mode === 'smtp' && (
          <div className={s.body} style={{ padding: 0 }}>
            <div className={s.row}>
              <Field className={s.grow} label="Mail server" required hint="For Microsoft 365: smtp.office365.com">
                <Input value={host} onChange={(_, d) => touch(setHost)(d.value)} />
              </Field>
              <Field label="Port" hint="587 (STARTTLS) or 465" style={{ width: 120 }}>
                <Input value={port} onChange={(_, d) => touch(setPort)(d.value)} inputMode="numeric" />
              </Field>
            </div>
            <Switch checked={secure} onChange={(_, d) => touch(setSecure)(d.checked)} label={secure ? 'Encrypted from the start (port 465)' : 'Upgrade to encryption (STARTTLS, port 587)'} />
            <div className={s.row}>
              <Field className={s.grow} label="User name" hint="Leave empty if the server needs no sign-in">
                <Input value={user} onChange={(_, d) => touch(setUser)(d.value)} autoComplete="off" />
              </Field>
              <Field className={s.grow} label="Password" hint={mail.smtp.passwordSet ? 'A password is saved. Type here only to replace it.' : undefined}>
                <Input type="password" value={password} onChange={(_, d) => touch(setPassword)(d.value)} autoComplete="new-password" placeholder={mail.smtp.passwordSet ? '••••••••' : ''} />
              </Field>
            </div>
            <div className={s.row}>
              <Field className={s.grow} label="Send from" required hint="Must be the mailbox above, or one it is allowed to send as">
                <Input value={from} onChange={(_, d) => touch(setFrom)(d.value)} />
              </Field>
              <Field className={s.grow} label="Sender name">
                <Input value={fromName} onChange={(_, d) => touch(setFromName)(d.value)} />
              </Field>
            </div>
          </div>
        )}

        {mode === 'hub' && (
          <div className={s.stack}>
            <MessageBar intent={mail.hub.available === false ? 'warning' : 'info'}>
              <MessageBarBody>
                {!mail.hub.connected
                  ? 'Connect this installation to a hub first (the card above).'
                  : mail.hub.available === true
                    ? "The hub's mail service is ready. Messages are handed to the hub, which sends them from its own address; the hub does not keep their contents."
                    : mail.hub.available === false
                      ? "The hub's mail service is not available for this installation (it is switched off or not set up in the hub). Ask a hub administrator."
                      : 'Waiting to hear from the hub (within a minute of connecting).'}
              </MessageBarBody>
            </MessageBar>
            <Field label="Sender name" hint="Shown with the hub's From address">
              <Input value={fromName} onChange={(_, d) => touch(setFromName)(d.value)} />
            </Field>
          </div>
        )}

        {err && (
          <MessageBar intent="error">
            <MessageBarBody>{err}</MessageBarBody>
          </MessageBar>
        )}
        <div className={s.row}>
          <Button appearance="primary" disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>

        {mail.mode !== 'none' && (
          <div className={s.stack}>
            <Text weight="semibold">Send a test email</Text>
            <div className={s.row}>
              <Field className={s.grow} label="To" hint={dirty ? 'Save your changes first: the test uses the saved settings.' : undefined}>
                <Input type="email" value={testTo} onChange={(_, d) => setTestTo(d.value)} />
              </Field>
              <Button disabled={dirty || !/^\S+@\S+\.\S+$/.test(testTo.trim()) || test?.state === 'sending'} onClick={() => void sendTest()}>
                {test?.state === 'sending' ? 'Sending' : 'Send test'}
              </Button>
            </div>
            {test && test.state !== 'sending' && (
              <MessageBar intent={test.state === 'sent' ? 'success' : 'error'}>
                <MessageBarBody>{test.message}</MessageBarBody>
              </MessageBar>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** The connection to a Voxshift Hub: connect with the token the hub showed, see whether reports are getting through, disconnect. */
function HubCard({ hub }: { hub: HubConnectionView }) {
  const s = useLocalStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const [hubUrl, setHubUrl] = useState(hub.hubUrl ?? DEFAULT_HUB_URL);
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const done = (v: BaseUrlView, message: string) => {
    setErr(null);
    setToken('');
    qc.setQueryData(['platform-settings'], v);
    notify(message);
  };
  const connect = useMutation({
    mutationFn: () => api<BaseUrlView>('/platform/hub', { method: 'PUT', body: JSON.stringify({ hubUrl, token: token.trim() }) }),
    onSuccess: (v) => done(v, 'Connected to the hub'),
    onError: (e) => setErr((e as Error).message),
  });
  const disconnect = useMutation({
    mutationFn: () => api<BaseUrlView>('/platform/hub', { method: 'DELETE' }),
    onSuccess: (v) => done(v, 'Disconnected from the hub'),
    onError: (e) => setErr((e as Error).message),
  });
  const remote = useMutation({
    mutationFn: (enabled: boolean) => api<BaseUrlView>('/platform/hub/remote-access', { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: (v) => done(v, v.hub.remoteAccess ? 'Remote access switched on' : 'Remote access switched off'),
    onError: (e) => setErr((e as Error).message),
  });
  const state = hubLinkState(hub);
  const addr = normalizeBaseUrl(hubUrl);
  const tokenOk = HUB_TOKEN_RE.test(token.trim());

  return (
    <Card>
      <div className={s.body}>
        <div className={s.stack}>
          <Text weight="semibold">Voxshift hub</Text>
          <MutedText>
            Lists this installation in a Voxshift hub so staff can see whether it is up and open it from one place. Once a minute it sends the hub two things: its version and whether it is healthy. No customer data is ever sent, and signing in here stays separate from the hub.
          </MutedText>
        </div>
        {hub.connected ? (
          <>
            <div className={s.current}>
              <Text className={s.code}>{hub.hubUrl}</Text>
              <Text className={s.code}>token {hub.tokenHint}</Text>
              <Badge appearance="tint" shape="rounded" color={state === 'ok' ? 'success' : state === 'failing' ? 'danger' : 'informative'}>
                {state === 'ok' ? 'Reporting' : state === 'failing' ? 'Not getting through' : 'Waiting for the first report'}
              </Badge>
            </div>
            {hub.lastOkAt && state === 'ok' && <MutedText>Last report accepted {new Date(hub.lastOkAt).toLocaleTimeString()}.</MutedText>}
            {hub.lastError && (
              <MessageBar intent="error">
                <MessageBarBody>{hub.lastError}</MessageBarBody>
              </MessageBar>
            )}
            <div className={s.stack}>
              <Switch
                checked={hub.remoteAccess}
                disabled={remote.isPending}
                label={hub.remoteAccess ? 'Staff can open this installation through the hub' : 'Remote access through the hub is off'}
                onChange={(_, d) => remote.mutate(d.checked)}
              />
              <MutedText>
                While this is on, people the hub has given access to can open this installation from the hub without a VPN. They still need a user name and password here, and the hub only
                passes their traffic through: it keeps none of it. You can switch it off at any time and it takes effect within seconds. It is off until someone here turns it on.
              </MutedText>
              {hub.remoteAccess && (
                <Text size={200} className={s.code}>
                  {hub.tunnelState === 'connected' ? 'Connected to the hub.' : hub.tunnelState === 'connecting' ? 'Connecting to the hub...' : hub.tunnelError ?? 'Not connected.'}
                </Text>
              )}
            </div>
            <div className={s.row}>
              <Button disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </Button>
            </div>
          </>
        ) : (
          <div className={s.hubRow}>
            <Field className={s.grow} label="Hub address" validationState={!addr.ok && hubUrl.trim() ? 'error' : 'none'} validationMessage={!addr.ok && hubUrl.trim() ? addr.error : undefined}>
              <Input value={hubUrl} onChange={(_, d) => setHubUrl(d.value)} />
            </Field>
            <Field className={s.grow} label="Instance token" hint="Shown once in the hub when this installation is registered there." validationState={token && !tokenOk ? 'error' : 'none'} validationMessage={token && !tokenOk ? 'That does not look like an instance token (it starts with vxh_).' : undefined}>
              <Input type="password" value={token} onChange={(_, d) => setToken(d.value)} autoComplete="off" />
            </Field>
            <Button className={s.hubButton} appearance="primary" disabled={!addr.ok || !tokenOk || connect.isPending} onClick={() => connect.mutate()}>
              Connect
            </Button>
          </div>
        )}
        {err && (
          <MessageBar intent="error">
            <MessageBarBody>{err}</MessageBarBody>
          </MessageBar>
        )}
      </div>
    </Card>
  );
}

/** Administration > Platform settings: the base URL (every link, the CORS allow-list, the assistant connection details), the master email switch and the hub connection. */
export function AdminPlatformSettings() {
  const s = useLocalStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  // While a hub connection has not reported in yet (or is failing) look again every few seconds, so the card shows the first report as soon as the worker
  // sends it (it reports once a minute); otherwise just keep the page fresh.
  const q = useQuery({
    queryKey: ['platform-settings'],
    queryFn: () => api<BaseUrlView | null>('/platform/settings'),
    refetchInterval: (query) => {
      const d = query.state.data;
      return d?.hub.connected && hubLinkState(d.hub) !== 'ok' ? 10_000 : 60_000;
    },
  });
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const view = q.data ?? null;
  useEffect(() => {
    if (view) setValue(view.baseUrl);
  }, [view?.baseUrl]);

  const save = useMutation({
    mutationFn: (baseUrl: string | null) => api<BaseUrlView>('/platform/base-url', { method: 'PUT', body: JSON.stringify({ baseUrl }) }),
    onSuccess: (v) => {
      setErr(null);
      qc.setQueryData(['platform-settings'], v);
      notify(v.source === 'setting' ? 'Web address saved' : 'Back to the installation default', { body: v.baseUrl });
    },
    onError: (e) => setErr((e as Error).message),
  });

  const email = useMutation({
    mutationFn: (enabled: boolean) => api<BaseUrlView>('/platform/email-delivery', { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: (v) => {
      qc.setQueryData(['platform-settings'], v);
      notify(v.emailEnabled ? 'Email switched on' : 'Email switched off', { body: v.emailEnabled ? 'The platform sends email again.' : 'No email is generated or sent.' });
    },
    onError: (e) => notify('Could not change the email setting', { body: (e as Error).message, intent: 'error' }),
  });

  const typed = normalizeBaseUrl(value);
  const typedError = value.trim() && !typed.ok ? typed.error : null;
  const changed = view != null && typed.ok && typed.url !== view.baseUrl;
  const here = window.location.origin;
  const warnings = typed.ok ? baseUrlWarnings(typed.url) : [];
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => notify('Copied'), () => notify('Could not copy', { intent: 'error' }));
  };

  return (
    <Page narrow platform title="Platform settings" subtitle={view ? `Voxshift ${view.version}. Settings that apply to the whole installation, for every customer.` : 'Settings that apply to the whole installation, for every customer.'}>
      {view && (
        <Card>
          <div className={s.body}>
            <div className={s.row}>
              <div className={`${s.grow} ${s.stack}`}>
                <Text weight="semibold">Email</Text>
                <MutedText>
                  The master switch for all email: invitations, password resets, incident and service request notices, reminders and reports. When it is off nothing is generated or queued, and anything already waiting is marked skipped instead of sent.
                </MutedText>
              </div>
              <Switch
                checked={view.emailEnabled}
                disabled={email.isPending}
                label={view.emailEnabled ? 'Email is on' : 'Email is off'}
                onChange={(_, d) => email.mutate(d.checked)}
              />
            </div>
            {!view.emailEnabled && (
              <MessageBar intent="warning">
                <MessageBarBody>No email is being sent. People will not receive invitations, password resets or notices until you switch it back on. Messages that would have been sent are not kept.</MessageBarBody>
              </MessageBar>
            )}
          </div>
        </Card>
      )}

      {view && <HubCard hub={view.hub} />}

      {view && <EmailCard key={`${view.mail.mode}-${view.mail.source}-${view.mail.smtp.host}-${view.mail.smtp.passwordSet}`} mail={view.mail} />}

      <Card>
        {q.isLoading ? (
          <Spinner label="Loading" />
        ) : q.isError || !view ? (
          <LoadError message={q.isError ? (q.error as Error).message : 'You do not have access to this setting.'} />
        ) : (
          <div className={s.body}>
            <div className={s.current}>
              <Text weight="semibold">Web address in use now</Text>
              <Text className={s.code}>{view.baseUrl}</Text>
              <Badge appearance="tint" color={view.source === 'setting' ? 'brand' : 'informative'}>
                {view.source === 'setting' ? 'Saved setting' : 'Installation default (WEB_ORIGIN)'}
              </Badge>
            </div>

            <div className={s.row}>
              <Field className={s.grow} label="Base URL" hint={`For example ${HOSTED_BASE_URL} or https://voice.contoso.local. No path, and no slash on the end.`} validationState={typedError ? 'error' : 'none'} validationMessage={typedError ?? undefined}>
                <Input value={value} onChange={(_, d) => setValue(d.value)} placeholder={HOSTED_BASE_URL} />
              </Field>
              <Button appearance="primary" disabled={!changed || save.isPending} onClick={() => typed.ok && save.mutate(typed.url)}>
                {save.isPending ? 'Saving' : 'Save'}
              </Button>
              {view.source === 'setting' && (
                <Button disabled={save.isPending} onClick={() => save.mutate(null)}>
                  Use the installation default
                </Button>
              )}
            </div>

            {here !== view.baseUrl && (
              <MessageBar intent="info">
                <MessageBarBody>You are using Voxshift at {here}, which is not the saved address.</MessageBarBody>
                <MessageBarActions>
                  <Button size="small" onClick={() => setValue(here)}>
                    Fill in this address
                  </Button>
                </MessageBarActions>
              </MessageBar>
            )}
            {warnings.map((w) => (
              <MessageBar key={w} intent="warning">
                <MessageBarBody>{w}</MessageBarBody>
              </MessageBar>
            ))}
            {err && (
              <MessageBar intent="error">
                <MessageBarBody>{err}</MessageBarBody>
              </MessageBar>
            )}
            <MutedText>
              Changing it does not move the application. It only changes the address written into emails and shown to assistants, so point your DNS, certificate and reverse proxy at this installation first. Sign-in cookies belong to the address people browse to, so staff sign in again if it changes.
            </MutedText>
          </div>
        )}
      </Card>

      {view && (
        <Card>
          <div className={s.body}>
            <Text weight="semibold">Connecting an assistant to this installation</Text>
            <MutedText>These follow the address above. Give them to whoever sets up the assistant; the token is created on Administration, Assistants.</MutedText>
            <div className={s.list}>
              {(
                [
                  ['VOXSHIFT_URL (MCP server)', view.connect.voxshiftUrl],
                  ['REST base for assistants', view.connect.agentApi],
                  ['Alert intake (monitoring tools)', view.connect.intakeAlerts],
                  ['Inbound email forwarder', view.connect.inboundEmail],
                ] as const
              ).map(([label, v]) => (
                <div key={label} className={s.line}>
                  <Text>{label}</Text>
                  <span className={s.code}>{v}</span>
                  <Button size="small" appearance="subtle" icon={<CopyRegular />} aria-label={`Copy ${label}`} onClick={() => copy(v)} />
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}
    </Page>
  );
}
