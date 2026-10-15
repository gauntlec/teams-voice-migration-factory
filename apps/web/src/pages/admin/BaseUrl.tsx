import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Field, Input, MessageBar, MessageBarActions, MessageBarBody, Spinner, Text, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { CopyRegular } from '@fluentui/react-icons';
import { HOSTED_BASE_URL, baseUrlWarnings, normalizeBaseUrl, type BaseUrlView } from '@tvmf/shared';
import { api } from '../../api';
import { Page } from '../../components/Page';
import { LoadError } from '../../components/records';
import { useNotify } from '../../hooks/useNotify';
import { MutedText } from '../../components/ui';

const useLocalStyles = makeStyles({
  body: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', ...shorthands.gap('16px'), ...shorthands.padding('16px') },
  row: { display: 'flex', ...shorthands.gap('12px'), alignItems: 'flex-end', flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '280px' },
  current: { display: 'flex', ...shorthands.gap('8px'), alignItems: 'center', flexWrap: 'wrap' },
  list: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', ...shorthands.gap('8px') },
  line: { display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr auto', ...shorthands.gap('8px'), alignItems: 'center' },
  code: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
});

/** Administration > Web address: the base URL every link, the CORS allow-list and the assistant connection details use. */
export function AdminBaseUrl() {
  const s = useLocalStyles();
  const qc = useQueryClient();
  const notify = useNotify();
  const q = useQuery({ queryKey: ['base-url'], queryFn: () => api<BaseUrlView | null>('/platform/base-url') });
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
      qc.setQueryData(['base-url'], v);
      notify(v.source === 'setting' ? 'Web address saved' : 'Back to the installation default', { body: v.baseUrl });
    },
    onError: (e) => setErr((e as Error).message),
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
    <Page narrow platform title="Web address" subtitle="The address people use to reach this installation. Every link in an email, the connection details for assistants and the cross-origin allow-list are built from it.">
      <Card>
        {q.isLoading ? (
          <Spinner label="Loading" />
        ) : q.isError || !view ? (
          <LoadError message={q.isError ? (q.error as Error).message : 'You do not have access to this setting.'} />
        ) : (
          <div className={s.body}>
            <div className={s.current}>
              <Text weight="semibold">In use now</Text>
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
